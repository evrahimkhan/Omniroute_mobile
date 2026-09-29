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
 * It also checks the *keep-alive* half of the same feature: the merged manifest
 * must declare the foreground service (and its Android-14 type + permissions),
 * because a manifest problem fails at runtime — on a phone, at startForeground —
 * and never in a Gradle build.
 *
 * Usage:
 *   node scripts/assert-apk-runtime.mjs <apk> [--abis arm64-v8a,armeabi-v7a]
 */

import { readFileSync, statSync } from 'node:fs';

import { extractEntry, listEntries } from './lib/minizip.mjs';

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

/**
 * Is `text` in the APK's binary AndroidManifest.xml?
 *
 * The manifest is compiled AXML, not text, but its string pool keeps the names
 * and string values — as UTF-8 in aapt2's default encoding, and historically as
 * UTF-16. Both are searched rather than assumed, because a miss here would look
 * like a missing declaration.
 *
 * What this cannot see: attributes whose value is not a string. aapt2 compiles
 * `foregroundServiceType="specialUse"` to the integer flag 0x40000000, so the
 * literal is nowhere in the file — that half of the contract is asserted on the
 * source manifest, against the constant the Kotlin actually passes to
 * `startForeground`, by `npm run runtime:contract`.
 */
function manifestContains(manifest, text) {
  return (
    manifest.includes(Buffer.from(text, 'utf8')) ||
    manifest.includes(Buffer.from(text, 'utf16le'))
  );
}

/**
 * Printable strings in the manifest, for when an assertion fails.
 *
 * A binary manifest is not readable by eye, so a failure would otherwise say
 * only "not found" — with no way to tell a wrong expectation from a declaration
 * the merger dropped.
 */
function manifestStrings(manifest, limit = 80) {
  const found = new Set();
  for (const match of manifest.toString('latin1').matchAll(/[ -~]{4,}/g)) found.add(match[0]);
  for (const match of manifest.toString('utf16le').matchAll(/[ -~]{4,}/g)) found.add(match[0]);
  return [...found].slice(0, limit);
}

/**
 * The gateway keeps serving with the app closed only because a foreground
 * service holds the process (docs/LOCAL_GATEWAY.md §5e). None of that is
 * visible to a Gradle build until it runs on a phone: a service that is not
 * declared, or a missing Android-14 foreground-service type, throws at
 * `startForeground()` — so the packaging is asserted here instead.
 */
function checkGatewayService(entries, apk) {
  const problems = [];
  const manifestEntry = entries.find((e) => e.name === 'AndroidManifest.xml');
  if (!manifestEntry) {
    return ['the APK has no AndroidManifest.xml (not an APK?)'];
  }

  const manifest = extractEntry(apk, manifestEntry);
  const declarations = [
    ['the gateway service', 'GatewayService'],
    // The *name* of the attribute, not its value: see the note above — the value
    // is an integer flag in this file and is checked against the Kotlin constant
    // by `npm run runtime:contract`.
    ['its foreground-service type attribute', 'foregroundServiceType'],
    ['the subtype property Android 14 wants', 'PROPERTY_SPECIAL_USE_FGS_SUBTYPE'],
    ['the foreground-service permission', 'android.permission.FOREGROUND_SERVICE'],
    ['the special-use permission', 'android.permission.FOREGROUND_SERVICE_SPECIAL_USE'],
    ['the notification permission', 'android.permission.POST_NOTIFICATIONS'],
    // Only presence is checked: the value lives in binary XML and parses as an
    // attribute, not a string. Presence still catches the real failure — a
    // build-properties key that never reached the merged manifest — which is
    // what would silently break LAN gateways and self-hosted HTTP servers.
    ['the cleartext opt-in (LAN gateways are plain HTTP)', 'usesCleartextTraffic'],
  ];

  for (const [label, needle] of declarations) {
    if (manifestContains(manifest, needle)) {
      process.stdout.write(`  ✓ ${label}\n`);
    } else {
      problems.push(`${label} is not in the merged manifest (${needle})`);
    }
  }

  if (problems.length) {
    problems.push(
      `manifest string pool, for reference: ${manifestStrings(manifest).join(' | ')}`
    );
  }
  return problems;
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

  // The JNI shim is built from source by the local Expo module, so its presence
  // proves the whole chain ran: autolinking picked the module up, CMake found
  // the runtime, and Gradle packaged the result.
  for (const abi of opts.abis) {
    const wanted = `lib/${abi}/libnoderuntime_jni.so`;
    const found = entries.find((e) => e.name === wanted);
    if (!found) {
      problems.push(`missing ${wanted} (the JNI bridge did not build or was not packaged)`);
      continue;
    }
    process.stdout.write(`  ✓ ${wanted}  ${human(found.uncompSize)}\n`);
  }

  problems.push(...checkGatewayService(entries, buf));

  if (problems.length) {
    process.stderr.write(`\n✖ the APK is missing embedded runtime pieces:\n  ${problems.join('\n  ')}\n`);
    process.stderr.write(
      '\nThings to check:\n' +
        '  · did `node scripts/fetch-node-runtime.mjs` run after `expo prebuild`?\n' +
        '  · is the file named libnode.so (not node)? the packager drops non-`lib*.so` files\n' +
        '  · are the ABIs in --abis the same ones Gradle built?\n' +
        '  · did the local module autolink? (npx expo-modules-autolinking search -p android)\n' +
        (libEntries.length
          ? `\n  native libs actually present:\n${libEntries.map((e) => `    ${e.name}`).join('\n')}\n`
          : '\n  the APK contains NO lib/ entries at all\n'),
    );
    process.exit(1);
  }

  process.stdout.write('✓ APK carries the embedded Node runtime, the JNI bridge and the keep-alive service\n');
}

try {
  main();
} catch (err) {
  process.stderr.write(`\n✖ assert-apk-runtime: ${err.message}\n`);
  process.exit(1);
}
