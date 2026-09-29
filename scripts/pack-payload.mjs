#!/usr/bin/env node
/**
 * Packages a built gateway into the payload the app downloads.
 *
 * The app installs this with `gateway/bootstrap.mjs`, so the archive has to be
 * a plain `tar.gz` with the server entry at the root (or one level down — the
 * installer handles npm's `package/` nesting too).
 *
 * Two reasons this is our own writer rather than `tar -czf`:
 *
 *  1. **Determinism.** Entries are sorted, and mtime/uid/gid/uname are fixed, so
 *     the same input always produces the same sha256. That is what lets the app
 *     pin a checksum and lets CI prove a rebuild produced identical bytes.
 *  2. **It is testable.** Round-tripping this output through system `tar` and
 *     through the installer's own extractor is something a shell one-liner
 *     cannot do as precisely.
 *
 * Paths longer than the 100-byte ustar field are written with pax extended
 * headers — unavoidable in `node_modules`, where deep paths are the norm.
 *
 *   node scripts/pack-payload.mjs <built-dir> [-o out.tar.gz] [--entry server.js]
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { readdirSync, lstatSync, readlinkSync, mkdirSync, statSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';

/** Fixed so the archive is byte-reproducible. */
const EPOCH = 0;
/** ustar's checksum field, and the values it uses for the "no value" cases. */
const BLOCK = 512;

function octal(buffer, offset, length, value) {
  // Octal, NUL-terminated, right-aligned: 0000755\0
  const text = value.toString(8).padStart(length - 1, '0');
  buffer.write(text.slice(0, length - 1), offset, 'ascii');
}

function writeString(buffer, offset, length, value) {
  const bytes = Buffer.from(value, 'utf8');
  // Truncating a path would silently corrupt the archive; callers check first.
  bytes.copy(buffer, offset, 0, Math.min(bytes.length, length));
}

function header({ name, mode, size, type, linkname = '' }) {
  const block = Buffer.alloc(BLOCK, 0);

  // Long names go through a pax record instead, so only the first 100 bytes are
  // used here (see paxRecord).
  writeString(block, 0, 100, name);
  octal(block, 100, 8, mode);
  octal(block, 108, 8, 0); // uid — fixed for reproducibility
  octal(block, 116, 8, 0); // gid
  octal(block, 124, 12, size);
  octal(block, 136, 12, EPOCH);
  block.fill(0x20, 148, 156); // checksum is computed over spaces
  block.write(type, 156, 1, 'ascii');
  writeString(block, 157, 100, linkname);
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  writeString(block, 265, 32, ''); // uname — fixed
  writeString(block, 297, 32, ''); // gname — fixed

  let sum = 0;
  for (const byte of block) sum += byte;
  const checksum = sum.toString(8).padStart(6, '0');
  block.write(checksum, 148, 6, 'ascii');
  block[154] = 0;
  block[155] = 0x20;

  return block;
}

/**
 * A pax extended header carries values that do not fit the ustar fields. Only
 * `path` is used here, but the format is generic.
 */
function paxRecord(fields) {
  const body = Object.entries(fields)
    .map(([key, value]) => {
      // Length includes itself, so it is computed by iteration until stable.
      const payload = `${key}=${value}\n`;
      let length = payload.length + 3;
      for (;;) {
        const candidate = `${length} ${payload}`;
        if (candidate.length === length) return candidate;
        length = candidate.length;
      }
    })
    .join('');
  return Buffer.from(body, 'utf8');
}

/** Recursively list everything under `root`, sorted, as tar entries. */
function collect(root) {
  const entries = [];

  const walk = (dir) => {
    const names = readdirSync(dir).sort();
    for (const name of names) {
      const full = join(dir, name);
      const rel = relative(root, full).split(sep).join('/');
      if (!rel || rel === '.' || rel.startsWith('..')) continue;
      const info = lstatSync(full);

      if (info.isDirectory()) {
        entries.push({ name: rel, type: '5', mode: 0o755, size: 0 });
        walk(full);
      } else if (info.isSymbolicLink()) {
        const target = readlinkSync(full);
        entries.push({ name: rel, type: '2', mode: 0o777, size: 0, linkname: target });
      } else if (info.isFile()) {
        // Keep the executable bit, drop the rest: mode noise breaks determinism.
        const mode = (info.mode & 0o111 ? 0o755 : 0o644);
        entries.push({ name: rel, type: '0', mode, size: info.size, path: full });
      }
      // Sockets/fifos/devices have no place in a payload and are skipped.
    }
  };

  walk(root);
  return entries;
}

async function pack(sourceDir, outPath, entryName) {
  const entries = collect(sourceDir);
  if (!entries.length) throw new Error(`${sourceDir} is empty`);

  const hasEntry = entries.some((e) => e.type === '0' && e.name === entryName);
  if (!hasEntry) {
    const near = entries
      .filter((e) => e.name.endsWith(entryName.split('/').pop()))
      .slice(0, 5)
      .map((e) => `    ${e.name}`);
    throw new Error(
      `${entryName} is not at the root of ${sourceDir}` +
        (near.length ? `\n  similarly named files:\n${near.join('\n')}` : '')
    );
  }

  const gzip = createGzip({ level: 9 });
  const out = createWriteStream(outPath);
  const done = pipeline(gzip, out);

  // `once` removes its listener after firing (and rejects on 'error'), so a
  // long loop does not accumulate listeners on the gzip stream.
  const write = async (chunk) => {
    if (!gzip.write(chunk)) await once(gzip, 'drain');
  };

  let bytes = 0;

  for (const item of entries) {
    // pax header first when the name cannot fit ustar's 100 bytes.
    if (Buffer.byteLength(item.name, 'utf8') > 100) {
      const record = paxRecord({ path: item.name });
      const paxName = `PaxHeaders/${item.name.slice(0, 80)}`;
      await write(header({ name: paxName, mode: 0o644, size: record.length, type: 'x' }));
      await write(record);
      const padding = (BLOCK - (record.length % BLOCK)) % BLOCK;
      if (padding) await write(Buffer.alloc(padding));
    }

    await write(
      header({
        name: item.name,
        mode: item.mode,
        size: item.size,
        type: item.type,
        linkname: item.linkname ?? '',
      })
    );

    if (item.type === '0') {
      // Sequential: file bodies must land in the archive in entry order.
      await pipeline(createReadStream(item.path), gzip, { end: false });
    }

    const padding = (BLOCK - (item.size % BLOCK)) % BLOCK;
    if (padding) await write(Buffer.alloc(padding));

    bytes += item.size;
  }

  // Two zero blocks terminate the archive.
  await write(Buffer.alloc(BLOCK * 2));
  gzip.end();
  await done;

  return { entries, bytes, files: entries.filter((e) => e.type === '0').length };
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function human(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

async function main() {
  const argv = process.argv.slice(2);
  const source = argv.find((a) => !a.startsWith('-'));
  const outIndex = argv.indexOf('-o');
  const entryIndex = argv.indexOf('--entry');
  const out = resolve(outIndex !== -1 ? argv[outIndex + 1] : 'omniroute-payload.tar.gz');
  const entry = entryIndex !== -1 ? argv[entryIndex + 1] : 'server.js';

  if (!source) {
    process.stderr.write(
      'usage: node scripts/pack-payload.mjs <built-dir> [-o out.tar.gz] [--entry server.js]\n'
    );
    process.exit(1);
  }

  const dir = resolve(source);
  if (!statSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);

  mkdirSync(dirname(out), { recursive: true });
  process.stdout.write(`→ packing ${dir}\n`);
  const result = await pack(dir, out, entry);
  const size = statSync(out).size;
  const sha = await sha256File(out);

  process.stdout.write(
    `  ${result.files} files, ${human(result.bytes)} uncompressed → ${human(size)}\n` +
      `  ${sha}\n` +
      `  ${out}\n`
  );

  // Machine-readable summary, for the workflow to publish alongside the payload.
  const manifest = {
    entry,
    sha256: sha,
    bytes: size,
    uncompressedBytes: result.bytes,
    files: result.files,
  };
  const manifestPath = `${out}.json`;
  const { writeFileSync } = await import('node:fs');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`  ${manifestPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`\n✖ pack-payload: ${err?.message ?? err}\n`);
  process.exit(1);
});
