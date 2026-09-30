#!/usr/bin/env node
/**
 * Native libraries in a payload that this phone cannot load.
 *
 * Why this exists. The gateway payload is assembled on a GitHub runner — an
 * x86-64 Linux machine — from a Next.js `standalone` tree, and `npm ci` resolves
 * "optional" native packages to whatever platform ran it: `@img/sharp-linux-x64`,
 * `@wreq-js/binding-linux-x64-musl`, and anything node-gyp compiled in place.
 * Nothing in that pipeline knows the phone is arm64. The install succeeds, the
 * payload boots, and the first `require()` that touches one of those binaries
 * kills the process with a SIGSEGV — no error, no stack, nothing in any log.
 *
 * Measured on a real device: 29 of 63 libraries in the published payload were
 * x86-64, and the app died in native code on every start.
 *
 * A wrong-arch library is not a subtle problem with a subtle fix: it can never
 * load, on any phone, ever. So this deletes it. What replaces it is either the
 * payload's own JavaScript fallback (upstream has them, and warns rather than
 * fails) or a plain `Cannot find module` error — which prints, which the app can
 * show, and which says which feature is unavailable instead of taking the whole
 * gateway down.
 *
 * Usage:
 *   node scripts/prune-native-libs.mjs <dir>            # remove them, report
 *   node scripts/prune-native-libs.mjs <dir> --check    # fail if any remain
 *
 *   --arch <name>   expected CPU (default: arm64)
 *   --json          machine-readable report
 */

import { lstatSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';

/** ELF e_machine values, for the CPUs a payload might have been built for. */
export const ELF_MACHINES = { 0x03: 'x86', 0x28: 'arm', 0x3e: 'x86-64', 0xb7: 'arm64' };

/** Directories that never hold a library the payload loads. */
const SKIP_DIRS = new Set(['.git', '.cache', '.next/cache']);

export function machineName(code) {
  return ELF_MACHINES[code] ?? `0x${code.toString(16)}`;
}

/**
 * The CPU an ELF file was built for, or null when it is not readable ELF.
 *
 * Twenty bytes: magic, class and `e_machine`. A truncated or non-ELF file reads
 * as null, which callers treat as "unknown", never as "wrong".
 */
export function elfMachine(file) {
  try {
    const fd = readFileSync(file, { flag: 'r' });
    if (fd.length < 20) return null;
    if (fd[0] !== 0x7f || fd[1] !== 0x45 || fd[2] !== 0x4c || fd[3] !== 0x46) return null;
    return fd.readUInt16LE(18);
  } catch {
    return null;
  }
}

/**
 * Every native library under `dir`, with the CPU it was built for.
 *
 * `.node` (node addons) and `.so` (shared objects a native addon loads) are the
 * two shapes that reach a payload. Symlinks are reported but not followed: a
 * standalone tree can hold links to the build machine, and following one would
 * inspect — or delete — something outside the payload.
 */
export function findNativeLibraries(dir, { maxEntries = 400_000 } = {}) {
  const found = [];
  const symlinks = [];
  const queue = [dir];
  let visited = 0;

  while (queue.length && visited < maxEntries) {
    const current = queue.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      const full = join(current, entry.name);
      let stats;
      try {
        stats = lstatSync(full);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) {
        symlinks.push(full);
        continue;
      }
      if (stats.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(full);
        continue;
      }
      if (!entry.name.endsWith('.node') && !entry.name.endsWith('.so')) continue;
      found.push({ file: full, machine: elfMachine(full) });
    }
  }
  return { libraries: found, symlinks, visited };
}

/** The libraries whose CPU is known and is not `expected` (or `null`). */
export function foreignLibraries(libraries, expected) {
  if (!expected) return [];
  return libraries.filter((item) => item.machine !== null && machineName(item.machine) !== expected);
}

function main(argv) {
  const args = argv.slice(2);
  const dir = args.find((arg) => !arg.startsWith('--'));
  const check = args.includes('--check');
  const asJson = args.includes('--json');
  const archAt = args.indexOf('--arch');
  const arch = archAt === -1 ? 'arm64' : args[archAt + 1];

  if (!dir) {
    process.stderr.write('usage: prune-native-libs.mjs <dir> [--check] [--arch name] [--json]\n');
    process.exit(2);
  }

  const { libraries, symlinks, visited } = findNativeLibraries(dir);
  const foreign = foreignLibraries(libraries, arch);
  const unreadable = libraries.length - libraries.filter((item) => item.machine !== null).length;

  if (check) {
    if (foreign.length) {
      process.stderr.write(
        `✖ ${foreign.length} of ${libraries.length} native libraries are built for another CPU than ${arch}:\n`
      );
      for (const item of foreign.slice(0, 20)) {
        process.stderr.write(`    ${relative(dir, item.file)} (${machineName(item.machine)})\n`);
      }
      process.stderr.write(
        '  A library for another CPU cannot load on the phone: the first require() that\n' +
          '  touches it kills the process with no output. Prune them before packing.\n'
      );
      process.exit(1);
    }
    process.stdout.write(
      `prune-native-libs: OK — ${libraries.length} native libraries, none foreign to ${arch}` +
        (unreadable ? ` (${unreadable} unreadable)` : '') +
        `, ${symlinks.length} symlinks, ${visited} entries\n`
    );
    return;
  }

  const removed = [];
  for (const item of foreign) {
    try {
      unlinkSync(item.file);
      removed.push(item);
    } catch {
      // A read-only or already-gone file is not worth failing a payload build
      // over — the --check run after this one decides whether it matters.
    }
  }

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          visited,
          libraries: libraries.length,
          removed: removed.map((item) => ({ file: relative(dir, item.file), machine: machineName(item.machine) })),
          unreadable,
          symlinks: symlinks.length,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (!removed.length) {
    process.stdout.write(`prune-native-libs: nothing to remove (${libraries.length} libraries, all for ${arch})\n`);
    return;
  }
  process.stdout.write(
    `prune-native-libs: removed ${removed.length} of ${libraries.length} native libraries built for another CPU:\n`
  );
  for (const item of removed.slice(0, 20)) {
    process.stdout.write(`    ${relative(dir, item.file)} (${machineName(item.machine)})\n`);
  }
  if (removed.length > 20) process.stdout.write(`    … and ${removed.length - 20} more\n`);
  process.stdout.write(
    '  None of these can load on a phone; the payload falls back to JavaScript, or the\n' +
      '  feature that needed them reports itself unavailable.\n'
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv);
}
