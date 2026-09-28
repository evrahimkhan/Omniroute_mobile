#!/usr/bin/env node
/**
 * CI helper — prove the built APK actually carries the embedded Node runtime.
 *
 * Packaging the runtime is the whole point of Phase 1 (docs/LOCAL_GATEWAY.md):
 * Android 10+ will not execute anything the app can write, so the only way the
 * gateway can run on-device is for `libnode.so` to sit in the APK's
 * `lib/<abi>/` directory and be extracted to the executable `/data/app` path at
 * install time. A build that silently drops it (a `.so` that is not named
 * `lib*.so` gets discarded by the packager, a missing jniLibs directory, a
 * mistyped ABI) would still produce a "successful" APK — hence this check.
 *
 * Usage:
 *   node scripts/assert-apk-runtime.mjs <apk> [--abis arm64-v8a,armeabi-v7a]
 */

import { readFileSync, statSync } from 'node:fs';

import { listEntries } from './lib/minizip.mjs';

const DEFAULT_ABIS = ['arm64-v8a', 'armeabi-v7a'];

function parseArgs(argv) {
  const opts = { apk: null, abis: DEFAULT_ABIS };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--abis') opts.abis = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (!opts.apk) opts.apk = argv[i];
  }
  return opts;
}

function human(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.apk) {
    process.stderr.write('usage: node scripts/assert-apk-runtime.mjs <apk> [--abis arm64-v8a,armeabi-v7a]\n');
    process.exit(2);
  }

  if (!statSync(opts.apk).isFile()) throw new Error(`not a file: ${opts.apk}`);
  const buf = readFileSync(opts.apk);
  const entries = listEntries(buf);

  process.stdout.write(`→ ${opts.apk} (${human(buf.length)}, ${entries.length} entries)\n`);

  const libEntries = entries.filter((e) => e.name.startsWith('lib/'));
  const problems = [];

  for (const abi of opts.abis) {
    const wanted = `lib/${abi}/libnode.so`;
    const found = entries.find((e) => e.name === wanted);
    if (!found) {
      problems.push(`missing ${wanted}`);
      continue;
    }
    const method = found.method === 0 ? 'stored' : found.method === 8 ? 'deflate' : `method ${found.method}`;
    process.stdout.write(`  ✓ ${wanted}  ${human(found.uncompSize)}  (${method})\n`);
  }

  if (problems.length) {
    process.stderr.write(`\n✖ embedded Node runtime is missing from the APK:\n  ${problems.join('\n  ')}\n`);
    process.stderr.write(
      '\nThings to check:\n' +
        '  · did `node scripts/fetch-node-runtime.mjs` run after `expo prebuild`?\n' +
        '  · is the file named libnode.so (not node)? the packager drops non-`lib*.so` files\n' +
        '  · are the ABIs in --abis the same ones Gradle built?\n' +
        (libEntries.length
          ? `\n  native libs actually present:\n${libEntries.map((e) => `    ${e.name}`).join('\n')}\n`
          : '\n  the APK contains NO lib/ entries at all\n'),
    );
    process.exit(1);
  }

  process.stdout.write('✓ APK carries the embedded Node runtime\n');
}

try {
  main();
} catch (err) {
  process.stderr.write(`\n✖ assert-apk-runtime: ${err.message}\n`);
  process.exit(1);
}
