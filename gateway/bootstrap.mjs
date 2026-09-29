/**
 * On-device gateway bootstrap: install the payload, then run it.
 *
 * This script runs inside the embedded Node runtime (see docs/LOCAL_GATEWAY.md),
 * started by the app's NodeRuntime module. It is the whole "install and set up"
 * step, deliberately in Node rather than in the app:
 *
 *   - the runtime already has fetch, crypto and zlib, so the app needs no
 *     download manager, no unzipper, and no new native dependency;
 *   - the app only has to start a script and read a log file (both of which the
 *     native module already exposes), and progress is visible in that log.
 *
 * It must also boot the server itself, because the runtime can only be started
 * once per process — there is no second chance to run something else.
 *
 * Configuration comes from the environment (the JNI bridge sets it before the
 * runtime starts, which is the only time it can be set):
 *
 *   GATEWAY_DIR           required. Where the payload is installed.
 *   GATEWAY_PAYLOAD_URL   tarball to install. Omitted = install step skipped.
 *   GATEWAY_PAYLOAD_SHA256  hex digest of that tarball; verified when present.
 *   GATEWAY_FORCE_INSTALL "1" to reinstall even if the marker matches.
 *   GATEWAY_PORT          default 20128.
 *   GATEWAY_HOST          default 127.0.0.1 — loopback only, by design.
 *   GATEWAY_ENTRY         default dist/server.js, relative to the install dir.
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const MARKER = 'install.json';
const PAYLOAD_NAME = 'payload.tar.gz';
/** Bytes between progress lines. Long installs must not look like a hang. */
const PROGRESS_BYTES = 8 * 1024 * 1024;

function log(...args) {
  console.log('[gateway]', ...args);
}

function fatal(err) {
  console.error('[gateway] FAILED:', err && err.stack ? err.stack : String(err));
  process.exit(1);
}

/**
 * Read exactly `n` bytes from an async iterator, or fewer at end of stream.
 * Tar is a stream of 512-byte blocks, so this is the natural primitive.
 */
class ByteReader {
  constructor(iterator) {
    this.iterator = iterator;
    this.chunks = [];
    this.length = 0;
    this.done = false;
  }

  async pull() {
    if (this.done) return false;
    const { value, done } = await this.iterator.next();
    if (done) {
      this.done = true;
      return false;
    }
    this.chunks.push(value);
    this.length += value.length;
    return true;
  }

  async read(n) {
    while (this.length < n) {
      const more = await this.pull();
      // A tar stream that ends mid-record is truncated, not merely short.
      if (!more) throw new Error(`truncated tar: wanted ${n} bytes, have ${this.length}`);
    }
    if (this.chunks.length === 1) {
      const chunk = this.chunks[0];
      this.chunks = [chunk.subarray(n)];
      this.length = chunk.length - n;
      return chunk.subarray(0, n);
    }
    const out = Buffer.allocUnsafe(n);
    let offset = 0;
    while (offset < n) {
      const chunk = this.chunks[0];
      const take = Math.min(chunk.length, n - offset);
      chunk.copy(out, offset, 0, take);
      offset += take;
      if (take === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(take);
    }
    this.length -= n;
    return out;
  }

  async skip(n) {
    let remaining = n;
    while (remaining > 0) {
      const take = Math.min(remaining, 512 * 1024);
      await this.read(take);
      remaining -= take;
    }
  }
}

/** Parse the numeric fields of a tar header (they are NUL/space padded octal). */
function readString(buffer, offset, length) {
  let end = buffer.indexOf(0, offset);
  if (end === -1 || end > offset + length) end = offset + length;
  return buffer.toString('utf8', offset, end).trim();
}

function readOctal(buffer, offset, length) {
  const text = readString(buffer, offset, length);
  if (!text) return 0;
  const value = parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}

/** pax extended headers carry long paths and sizes as "len key=value\n" records. */
function parsePax(buffer) {
  const out = {};
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space === -1) break;
    const length = parseInt(buffer.toString('utf8', offset, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = buffer.toString('utf8', space + 1, offset + length - 1);
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    offset += length;
  }
  return out;
}

/**
 * Extract a .tar.gz into `destDir`.
 *
 * Supports the entry types a published bundle actually contains: files,
 * directories, pax/gnu long names, and symlinks. Anything else (hardlinks,
 * devices, fifos) is counted and reported rather than silently dropped.
 */
async function extractTarGz(tarballPath, destDir) {
  const raw = createReadStream(tarballPath);
  const gunzip = createGunzip();
  raw.pipe(gunzip);

  const reader = new ByteReader(gunzip[Symbol.asyncIterator]());

  await fs.mkdir(destDir, { recursive: true });

  let files = 0;
  let dirs = 0;
  let bytes = 0;
  let skipped = 0;
  let pendingPax = null;
  let pendingLongName = null;
  let lastProgress = 0;

  const stats = () => `${files} files, ${(bytes / (1024 * 1024)).toFixed(1)} MB`;

  for (;;) {
    const header = await reader.read(512);
    // A zero block terminates the archive (tar writes two, then pads with zeros).
    if (header.every((byte) => byte === 0)) break;

    let name = pendingLongName ?? readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    if (!pendingLongName && prefix) name = `${prefix}/${name}`;
    const mode = readOctal(header, 100, 8) || 0o644;
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156]) || '0';
    const linkName = readString(header, 157, 100);

    pendingLongName = null;

    if (type === 'x' || type === 'g') {
      const data = await reader.read(size);
      pendingPax = parsePax(data);
      // pax records override the ustar header fields for the next entry.
      continue;
    }

    if (pendingPax && pendingPax.path) {
      name = pendingPax.path;
      pendingPax = null;
    }

    if (type === 'L') {
      // GNU long name: the payload is the name of the *next* entry.
      const data = await reader.read(size);
      pendingLongName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }

    // Guard against a malicious or corrupt archive escaping the destination.
    const target = path.resolve(destDir, name);
    if (target !== destDir && !target.startsWith(destDir + path.sep)) {
      throw new Error(`refusing to extract outside the install dir: ${name}`);
    }

    if (type === '5') {
      await fs.mkdir(target, { recursive: true, mode });
      dirs++;
    } else if (type === '0' || type === '\0') {
      await fs.mkdir(path.dirname(target), { recursive: true });
      const chunks = [];
      let remaining = size;
      while (remaining > 0) {
        const take = Math.min(remaining, 1024 * 1024);
        chunks.push(await reader.read(take));
        remaining -= take;
      }
      await fs.writeFile(target, Buffer.concat(chunks), { mode });
      files++;
      bytes += size;
      const step = Math.floor(bytes / PROGRESS_BYTES);
      if (step > lastProgress) {
        lastProgress = step;
        log(`extracting… ${stats()}`);
      }
    } else if (type === '2') {
      await fs.mkdir(path.dirname(target), { recursive: true });
      try {
        await fs.symlink(linkName, target);
        files++;
      } catch (err) {
        // Some Android filesystems refuse symlinks; a bundle should not need them.
        skipped++;
        log(`warning: could not create symlink ${name} -> ${linkName}: ${err.message}`);
      }
    } else {
      skipped++;
      await reader.skip(size);
    }

    // Records are padded to a 512-byte boundary.
    const padding = (512 - (size % 512)) % 512;
    if (padding) await reader.skip(padding);
  }

  log(`extracted ${stats()}, ${dirs} dirs${skipped ? `, ${skipped} unsupported entries skipped` : ''}`);
  return { files, bytes, dirs, skipped };
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function download(url, destPath) {
  log(`downloading ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status} ${response.statusText}`);
  if (!response.body) throw new Error('download failed: empty response body');

  const total = Number(response.headers.get('content-length') || 0);
  if (total) log(`payload is ${(total / (1024 * 1024)).toFixed(1)} MB`);

  let received = 0;
  let lastProgress = 0;
  const body = Readable.fromWeb(response.body);
  body.on('data', (chunk) => {
    received += chunk.length;
    const step = Math.floor(received / PROGRESS_BYTES);
    if (step > lastProgress) {
      lastProgress = step;
      const percent = total ? ` (${((received / total) * 100).toFixed(0)}%)` : '';
      log(`downloaded ${(received / (1024 * 1024)).toFixed(1)} MB${percent}`);
    }
  });

  await pipeline(body, createWriteStream(destPath));
  log(`downloaded ${(received / (1024 * 1024)).toFixed(1)} MB`);
  return received;
}

/**
 * Find the directory inside an extracted payload that holds the entry script.
 *
 * Tarballs do not agree on roots: a hand-rolled bundle puts `dist/server.js` at
 * the top, while `npm pack` nests everything under `package/`. Accept either —
 * exactly one level of nesting, and only when it is unambiguous.
 */
async function resolveAppRoot(staging, entry) {
  if (existsSync(path.join(staging, entry))) return staging;
  const top = (await fs.readdir(staging, { withFileTypes: true })).filter((item) => item.isDirectory());
  const matches = top.filter((item) => existsSync(path.join(staging, item.name, entry)));
  if (matches.length === 1) {
    log(`payload is nested under ${matches[0].name}/`);
    return path.join(staging, matches[0].name);
  }
  return staging;
}

async function readMarker(dir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, MARKER), 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const gatewayDir = process.env.GATEWAY_DIR;
  if (!gatewayDir) fatal(new Error('GATEWAY_DIR is required'));

  const appDir = path.join(gatewayDir, 'app');
  const entry = process.env.GATEWAY_ENTRY || 'dist/server.js';
  const url = process.env.GATEWAY_PAYLOAD_URL || '';
  const expectedSha = (process.env.GATEWAY_PAYLOAD_SHA256 || '').trim().toLowerCase();
  const force = process.env.GATEWAY_FORCE_INSTALL === '1';

  await fs.mkdir(gatewayDir, { recursive: true });

  const marker = await readMarker(gatewayDir);
  const installed = existsSync(path.join(appDir, entry));
  const markerMatches = Boolean(marker) && (!expectedSha || marker.sha256 === expectedSha);
  const upToDate = installed && markerMatches && !force;

  if (upToDate) {
    log(`gateway already installed at ${appDir}${marker?.installedAt ? ` (${marker.installedAt})` : ''}`);
  } else {
    if (!url) {
      fatal(
        new Error(
          installed
            ? 'GATEWAY_PAYLOAD_URL is required to (re)install the gateway'
            : `no gateway installed at ${appDir} and no GATEWAY_PAYLOAD_URL was provided`
        )
      );
    }

    const tarballPath = path.join(gatewayDir, PAYLOAD_NAME);
    const partPath = `${tarballPath}.part`;

    try {
      await fs.rm(partPath, { force: true });

      // A previous run may have downloaded the payload and failed later (an
      // interrupted extract, a killed app). Re-downloading 100+ MB to get to the
      // same bytes is a poor use of someone's mobile data.
      let haveTarball = false;
      if (existsSync(tarballPath)) {
        if (expectedSha) {
          const existing = await sha256File(tarballPath);
          haveTarball = existing === expectedSha;
          log(haveTarball ? 'reusing the previously downloaded payload' : 'existing payload is stale, downloading again');
        } else {
          log('an existing payload is present but cannot be verified without GATEWAY_PAYLOAD_SHA256 — downloading again');
        }
      }

      if (!haveTarball) {
        await download(url, partPath);

        if (expectedSha) {
          log('verifying checksum…');
          const actualSha = await sha256File(partPath);
          if (actualSha !== expectedSha) {
            throw new Error(`checksum mismatch: expected ${expectedSha}, got ${actualSha}`);
          }
          log('checksum ok');
        } else {
          log('warning: GATEWAY_PAYLOAD_SHA256 is not set — installing without integrity verification');
        }

        await fs.rename(partPath, tarballPath);
      }

      // Extract beside the live directory and swap, so a crash mid-extract does
      // not leave a half-written app that looks installed.
      const staging = path.join(gatewayDir, 'app.new');
      await fs.rm(staging, { recursive: true, force: true });
      await extractTarGz(tarballPath, staging);

      const appRoot = await resolveAppRoot(staging, entry);
      if (!existsSync(path.join(appRoot, entry))) {
        throw new Error(`payload does not contain ${entry}`);
      }
      if (appRoot !== staging) {
        // Normalise to <gatewayDir>/app so the boot path does not depend on how
        // the payload happened to be packaged.
        const flattened = `${staging}.flat`;
        await fs.rm(flattened, { recursive: true, force: true });
        await fs.rename(appRoot, flattened);
        await fs.rm(staging, { recursive: true, force: true });
        await fs.rename(flattened, staging);
      }

      await fs.rm(appDir, { recursive: true, force: true });
      await fs.rename(staging, appDir);

      await fs.writeFile(
        path.join(gatewayDir, MARKER),
        JSON.stringify({ url, sha256: expectedSha || null, installedAt: new Date().toISOString() }, null, 2)
      );
      // The tarball has served its purpose; keeping it doubles the footprint.
      await fs.rm(tarballPath, { force: true });
      log('install complete');
    } catch (err) {
      await fs.rm(partPath, { force: true }).catch(() => {});
      fatal(err);
    }
  }

  // Boot the gateway in-process. There is no second chance: the embedded
  // runtime starts once per app process.
  const serverEntry = path.resolve(appDir, entry);
  process.env.PORT = process.env.GATEWAY_PORT || process.env.PORT || '20128';
  process.env.HOSTNAME = process.env.GATEWAY_HOST || process.env.HOSTNAME || '127.0.0.1';
  process.env.NODE_ENV = process.env.NODE_ENV || 'production';
  process.chdir(path.dirname(serverEntry));

  log(`starting ${entry} on ${process.env.HOSTNAME}:${process.env.PORT}`);
  try {
    await import(pathToFileURL(serverEntry).href);
  } catch (err) {
    fatal(err);
  }
}

// Only install+boot when executed as a program: importing this module (from a
// test, say) must not start downloading things.
const isDirectRun =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) main().catch(fatal);

export { extractTarGz, sha256File, parsePax };
