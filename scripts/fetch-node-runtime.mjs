#!/usr/bin/env node
/**
 * CI/build helper — place the embedded Node runtime into the Android project.
 *
 * The app hosts the npm OmniRoute gateway on-device (see docs/LOCAL_GATEWAY.md).
 * Android 10+ refuses to `execve` anything the app can write, so the runtime
 * **must** ship inside the APK: it has to live in `jniLibs/<abi>/` so that
 * PackageManager extracts it into the read-only, executable `/data/app/.../lib`
 * directory. That is Google's documented workaround, and it is why the runtime
 * is bundled while the 431 MB OmniRoute payload is downloaded after install.
 *
 * Downloads the Node-on-mobile Android archive, pulls `libnode.so` out of it for
 * the requested ABIs, and writes them into the native libs directory.
 *
 * Usage:
 *   node scripts/fetch-node-runtime.mjs                       # download + install
 *   node scripts/fetch-node-runtime.mjs --dry-run             # report, write nothing
 *   node scripts/fetch-node-runtime.mjs --from-zip rt.zip     # offline / testing
 *   node scripts/fetch-node-runtime.mjs --abis arm64-v8a
 *
 * Env overrides:
 *   NODE_RUNTIME_URL      archive to fetch
 *   NODE_RUNTIME_SHA256   expected sha256 of the archive (verified when set)
 */

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { extractEntry, listEntries } from './lib/minizip.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Pinned on purpose — bump deliberately, and keep the checksum in CI. */
export const DEFAULT_RUNTIME_URL =
  'https://github.com/digidem/nodejs-mobile/releases/download/v24.20.0-0/nodejs-mobile-android-24.20.0-0.zip';

/** Node 24.20.0 satisfies OmniRoute's `>=22.22.2 <23 || >=24.0.0 <27`. */
export const RUNTIME_NODE_VERSION = '24.20.0';

const KNOWN_ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'];

/** The local Expo module that links against the runtime. */
const MODULE_ANDROID = join(ROOT, 'modules', 'node-runtime', 'android', 'src', 'main');

function parseArgs(argv) {
  const opts = {
    abis: ['arm64-v8a', 'armeabi-v7a'],
    // Into the module (not the app): a library module's jniLibs are merged into
    // the APK automatically, and keeping the runtime inside the module keeps
    // the CMake paths short and stable.
    out: join(MODULE_ANDROID, 'jniLibs'),
    headersOut: join(MODULE_ANDROID, 'cpp', 'include'),
    fromZip: null,
    url: process.env.NODE_RUNTIME_URL || DEFAULT_RUNTIME_URL,
    sha256: process.env.NODE_RUNTIME_SHA256 || '',
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--abis') opts.abis = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--out') opts.out = resolve(argv[++i]);
    else if (arg === '--headers-out') opts.headersOut = resolve(argv[++i]);
    else if (arg === '--no-headers') opts.headersOut = null;
    else if (arg === '--from-zip') opts.fromZip = resolve(argv[++i]);
    else if (arg === '--url') opts.url = argv[++i];
    else if (arg === '--sha256') opts.sha256 = argv[++i];
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

async function download(url) {
  const target = join(tmpdir(), `node-runtime-${process.pid}.zip`);
  process.stdout.write(`→ downloading ${url}\n`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get('content-length') || 0);
  const chunks = [];
  let seen = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    seen += chunk.length;
    if (total) {
      const pct = Math.floor((seen / total) * 100);
      if (pct % 20 === 0) process.stdout.write(`  ${pct}%\r`);
    }
  }
  process.stdout.write('  100%\n');
  const buf = Buffer.concat(chunks);
  writeFileSync(target, buf);
  return { buf, target };
}

/** Map a zip entry path to an ABI using any path segment that names one. */
function abiForEntry(name, requested) {
  const segments = name.split('/');
  for (const seg of segments) {
    const normalized = seg.toLowerCase();
    if (KNOWN_ABIS.includes(normalized) && requested.includes(normalized)) return normalized;
  }
  return null;
}

function human(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0] + '\n');
    return;
  }

  for (const abi of opts.abis) {
    if (!KNOWN_ABIS.includes(abi)) throw new Error(`unknown ABI "${abi}" (expected one of ${KNOWN_ABIS.join(', ')})`);
  }

  let buf;
  let source;
  if (opts.fromZip) {
    source = opts.fromZip;
    buf = readFileSync(opts.fromZip);
    process.stdout.write(`→ using local archive ${opts.fromZip}\n`);
  } else {
    const downloaded = await download(opts.url);
    buf = downloaded.buf;
    source = opts.url;
  }

  if (opts.sha256) {
    const actual = createHash('sha256').update(buf).digest('hex');
    if (actual.toLowerCase() !== opts.sha256.toLowerCase()) {
      throw new Error(`sha256 mismatch for ${source}\n  expected ${opts.sha256}\n  actual   ${actual}`);
    }
    process.stdout.write('→ sha256 verified\n');
  } else if (!opts.fromZip) {
    process.stdout.write('· no NODE_RUNTIME_SHA256 set — skipping checksum verification (pin it in CI)\n');
  }

  const entries = listEntries(buf);
  const libnodeEntries = entries.filter((e) => e.name.split('/').pop() === 'libnode.so');
  if (!libnodeEntries.length) {
    throw new Error(
      `no libnode.so found in the archive.\nA sample of what is inside:\n  ${entries.slice(0, 12).map((e) => e.name).join('\n  ')}`,
    );
  }

  // Entry paths look like bin/<abi>/libnode.so or out_android/<abi>/libnode.so
  // depending on how the release was packaged — match on the ABI segment rather
  // than hardcoding a prefix.
  const byAbi = new Map();
  for (const entry of libnodeEntries) {
    const abi = abiForEntry(entry.name, opts.abis);
    if (abi && !byAbi.has(abi)) byAbi.set(abi, entry);
  }

  // Fallback: a flat single-binary archive. Only unambiguous when one ABI asked for.
  if (!byAbi.size && libnodeEntries.length === 1 && opts.abis.length === 1) {
    process.stdout.write(`· archive has a single libnode.so with no ABI directory — assuming ${opts.abis[0]}\n`);
    byAbi.set(opts.abis[0], libnodeEntries[0]);
  }

  const missing = opts.abis.filter((abi) => !byAbi.has(abi));
  if (missing.length) {
    throw new Error(
      `archive has no libnode.so for: ${missing.join(', ')}\n` +
        `  found: ${libnodeEntries.map((e) => e.name).join(', ')}`,
    );
  }

  process.stdout.write(`→ node runtime ${RUNTIME_NODE_VERSION} from ${source.split('/').pop()}\n`);

  let written = 0;
  for (const abi of opts.abis) {
    const entry = byAbi.get(abi);
    const dest = join(opts.out, abi, 'libnode.so');
    const label = `  ${abi.padEnd(12)} ${human(entry.uncompSize)}  ${entry.name}`;
    if (opts.dryRun) {
      process.stdout.write(`${label}\n    → would write ${dest}\n`);
      continue;
    }
    const data = extractEntry(buf, entry);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data);
    // Executables in jniLibs are extracted as files; keep the mode sane anyway.
    chmodSync(dest, 0o755);
    process.stdout.write(`${label}\n    → ${dest}\n`);
    written++;
  }

  // Headers: only their directory name matters, since the shim includes
  // "node.h" / "node_version.h" directly.
  if (opts.headersOut) {
    const headers = entries.filter((e) => /(^|\/)include\/(node|v8|uv)\//.test(e.name) || /include\/(node|node_version)\.h$/.test(e.name));
    if (!headers.length) {
      process.stdout.write('· no headers found in the archive (the shim can still build if they are cached)\n');
    } else {
      let headerCount = 0;
      let headerBytes = 0;
      for (const entry of headers) {
        // Strip everything up to and including the first "include/" segment.
        const idx = entry.name.indexOf('include/');
        const relative = entry.name.slice(idx + 'include/'.length);
        if (!relative || relative.endsWith('/')) continue;
        const dest = join(opts.headersOut, relative);
        if (opts.dryRun) {
          headerCount++;
          headerBytes += entry.uncompSize;
          continue;
        }
        const data = extractEntry(buf, entry);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, data);
        headerCount++;
        headerBytes += data.length;
      }
      const verb = opts.dryRun ? 'would write' : 'wrote';
      process.stdout.write(`  headers      ${headerCount} file(s), ${human(headerBytes)}  ${verb} ${opts.headersOut}\n`);
    }
  }

  if (opts.dryRun) {
    process.stdout.write('\ndry run: nothing written\n');
    return;
  }
  process.stdout.write(`\n✓ placed ${written} libnode.so file(s) in ${opts.out}\n`);
}

main().catch((err) => {
  process.stderr.write(`\n✖ fetch-node-runtime: ${err.message}\n`);
  process.exit(1);
});
