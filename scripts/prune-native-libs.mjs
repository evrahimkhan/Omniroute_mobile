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

import { closeSync, lstatSync, openSync, readFileSync, readdirSync, readSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';

/** ELF e_machine values, for the CPUs a payload might have been built for. */
export const ELF_MACHINES = { 0x03: 'x86', 0x28: 'arm', 0x3e: 'x86-64', 0xb7: 'arm64' };

/** Directories that never hold a library the payload loads. */
const SKIP_DIRS = new Set(['.git', '.cache', '.next/cache']);

/**
 * Markers of a libc Android does not have.
 *
 * Android's libc is Bionic, and it is not glibc or musl: a shared library linked
 * against either is refused by the dynamic linker, however right its CPU is.
 * These are the strings such a library always carries — `GLIBC_2.x` version
 * references, a `libc.musl-…` dependency — and an Android-built library has
 * neither. Right CPU is necessary and not sufficient.
 */
export const LIBC_MARKERS = [
  { marker: 'GLIBC_', flavour: 'glibc' },
  { marker: 'libc.musl-', flavour: 'musl' },
];

const LIBC_CHUNK_BYTES = 4 * 1024 * 1024;
const LIBC_OVERLAP = 32;

/**
 * The libc an ELF file was linked against, when it is one Android cannot use.
 *
 * Scanned rather than parsed: the marker lives in the dynamic string table, and
 * reaching the table means walking section headers and their offsets — a great
 * deal of code to read four bytes of it. A substring search finds the same
 * thing, once, and the file only has to be read once.
 */
export function libcFlavour(file, { maxBytes = 64 * 1024 * 1024 } = {}) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const chunk = Buffer.alloc(LIBC_CHUNK_BYTES + LIBC_OVERLAP);
    let offset = 0;
    while (offset < maxBytes) {
      const read = readSync(fd, chunk, 0, LIBC_CHUNK_BYTES + LIBC_OVERLAP, offset);
      if (read <= 0) return null;
      // latin1 maps one byte to one character, so a marker cannot be split by
      // decoding — only by the chunk boundary, which the overlap covers.
      const text = chunk.toString('latin1', 0, read);
      for (const { marker, flavour } of LIBC_MARKERS) {
        if (text.includes(marker)) return flavour;
      }
      if (read <= LIBC_OVERLAP) return null;
      offset += LIBC_CHUNK_BYTES;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing useful to do about a failing close here.
      }
    }
  }
}

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
      const machine = elfMachine(full);
      // Only worth reading for the libc when the CPU is already acceptable — a
      // wrong-CPU library is deleted either way, and the read is not free.
      const libc = machine === null ? null : libcFlavour(full);
      found.push({ file: full, machine, stat: stats.size, libc });
    }
  }
  return { libraries: found, symlinks, visited };
}

/**
 * `process.arch` spellings, mapped onto ELF's.
 *
 * The option takes an ELF machine name (`arm64`, `x86-64`) because that is what
 * it is compared against, but `process.arch` is what a caller knows it has
 * (`x64`, `ia32`) — and a mismatch between the two vocabularies is not a small
 * thing here: an unrecognised name matches nothing, so *every* library in the
 * payload looks foreign and all of them get deleted.
 */
export const ARCH_ALIASES = { x64: 'x86-64', ia32: 'x86', arm: 'arm', arm64: 'arm64' };

/** The libraries whose CPU is known and is not `expected` (or `null`). */
export function foreignLibraries(libraries, expected) {
  if (!expected) return [];
  return libraries.filter((item) => item.machine !== null && machineName(item.machine) !== expected);
}

/**
 * Every library in the payload that a phone could not load, and why.
 *
 * Two independent reasons, and a payload only has to fail once: the wrong CPU
 * (the payload is built on an x86-64 runner) or the wrong libc (a desktop glibc
 * or musl binary, which Android's Bionic refuses). A wrong-CPU library is not
 * worth reading for its libc — it is leaving either way.
 */
export function unloadableLibraries(libraries, expected) {
  const wrongArch = foreignLibraries(libraries, expected);
  const wrongLibc = libraries.filter(
    (item) => item.libc && !wrongArch.includes(item) && (expected === null || machineName(item.machine) === expected)
  );
  return { wrongArch, wrongLibc, all: [...wrongArch, ...wrongLibc] };
}

function main(argv) {
  const args = argv.slice(2);
  const dir = args.find((arg) => !arg.startsWith('--'));
  const check = args.includes('--check');
  const asJson = args.includes('--json');
  const archAt = args.indexOf('--arch');
  const requested = archAt === -1 ? 'arm64' : args[archAt + 1];
  const arch = ARCH_ALIASES[requested] ?? requested;

  if (!dir) {
    process.stderr.write('usage: prune-native-libs.mjs <dir> [--check] [--arch name] [--json]\n');
    process.exit(2);
  }
  // An unknown name would classify every library as foreign and delete the lot,
  // so it is refused rather than guessed at.
  if (!Object.values(ELF_MACHINES).includes(arch)) {
    process.stderr.write(
      `✖ unknown --arch ${requested}: expected one of ${Object.values(ELF_MACHINES).join(', ')}\n`
    );
    process.exit(2);
  }

  const { libraries, symlinks, visited } = findNativeLibraries(dir);
  const { wrongArch, wrongLibc, all } = unloadableLibraries(libraries, arch);
  const unreadable = libraries.length - libraries.filter((item) => item.machine !== null).length;
  const reasonFor = (item) => (item.libc ? `desktop ${item.libc}` : machineName(item.machine));

  if (check) {
    if (all.length) {
      process.stderr.write(
        `✖ ${all.length} of ${libraries.length} native libraries cannot load on a phone ` +
          `(${wrongArch.length} for another CPU than ${arch}, ${wrongLibc.length} for a desktop libc):\n`
      );
      for (const item of all.slice(0, 20)) {
        process.stderr.write(`    ${relative(dir, item.file)} (${reasonFor(item)})\n`);
      }
      process.stderr.write(
        '  Android can load only libraries built for its own CPU and its own libc (Bionic):\n' +
          '  the first require() of one of these is a crash, or an error where nothing is\n' +
          '  watching. Prune them before packing.\n'
      );
      process.exit(1);
    }
    process.stdout.write(
      `prune-native-libs: OK — ${libraries.length} native libraries, all loadable on ${arch}/Bionic` +
        (unreadable ? ` (${unreadable} unreadable)` : '') +
        `, ${symlinks.length} symlinks, ${visited} entries\n`
    );
    return;
  }

  const removed = [];
  for (const item of all) {
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
          removed: removed.map((item) => ({
            file: relative(dir, item.file),
            machine: machineName(item.machine),
            libc: item.libc ?? null,
          })),
          wrongArch: wrongArch.length,
          wrongLibc: wrongLibc.length,
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
    process.stdout.write(
      `prune-native-libs: nothing to remove (${libraries.length} libraries, all loadable on ${arch}/Bionic)\n`
    );
    return;
  }
  process.stdout.write(
    `prune-native-libs: removed ${removed.length} of ${libraries.length} native libraries that cannot load on ` +
      `a phone (${wrongArch.length} for another CPU than ${arch}, ${wrongLibc.length} for a desktop libc):\n`
  );
  for (const item of removed.slice(0, 20)) {
    process.stdout.write(`    ${relative(dir, item.file)} (${reasonFor(item)})\n`);
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
