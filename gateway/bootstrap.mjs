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
import {
  appendFileSync,
  closeSync,
  readFileSync,
  readdirSync,
  readSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { statfsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MARKER = 'install.json';
const PAYLOAD_NAME = 'payload.tar.gz';
/** Bytes between progress lines. Long installs must not look like a hang. */
const PROGRESS_BYTES = 8 * 1024 * 1024;

/**
 * Space the install is allowed to assume, when the payload's size is unknown.
 *
 * The published payload unpacks into tens of thousands of files, so the archive
 * and its contents both have to fit; three times the archive is the rule used
 * below, and this is the floor for when a server sends no Content-Length.
 */
const MIN_FREE_BYTES = 1536 * 1024 * 1024;

/**
 * How long a download may go without a single byte before it is called stalled.
 *
 * Wi-Fi that drops does not reset the connection on Android, it just stops
 * delivering: without this, an install can sit on a dead socket indefinitely,
 * showing the progress of a download that is not happening. Overridable so a
 * test does not have to wait two minutes to exercise it.
 */
const STALL_MS = Number(process.env.GATEWAY_DOWNLOAD_STALL_MS || '') || 120_000;

/**
 * How long to keep asking the freshly started server whether it is up.
 *
 * Only for the log: the app does its own waiting, and a slow first boot on a
 * phone is normal rather than a failure. The point is that the log distinguishes
 * "never answered" from "answered and later died".
 */
const HEALTH_TIMEOUT_MS = Number(process.env.GATEWAY_HEALTH_TIMEOUT_MS || '') || 10 * 60 * 1000;

function mb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Size of a file, or 0 when it is not there (or cannot be read). */
function fileSize(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Free bytes on the filesystem holding `dir`, or null when the platform will not
 * say.
 *
 * `statfs` is a syscall, and it works on Android. A failure here must not stop an
 * install that might otherwise work, so it only ever removes the check.
 */
function freeBytes(dir) {
  try {
    const stats = statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

/**
 * The gateway's own log, next to everything else it installs.
 *
 * Deliberately separate from the runtime log the app also reads. That one is a
 * process-wide capture of stdout/stderr (Android gives a native library no
 * console, so it is the only way to see a crash), and it therefore collects
 * whatever else in the app writes there — Android WebView logs a steady stream
 * of its own. Sharing one file meant browser chatter could push the gateway's
 * own lines out of the window the app reads, so a failed install looked exactly
 * like one that never started.
 */
const GATEWAY_LOG_NAME = 'gateway.log';

function gatewayLogPath() {
  return process.env.GATEWAY_DIR ? path.join(process.env.GATEWAY_DIR, GATEWAY_LOG_NAME) : '';
}

function appendToGatewayLog(line) {
  const file = gatewayLogPath();
  if (!file) return;
  try {
    appendFileSync(file, `${line}\n`);
  } catch {
    // Logging must never be the reason an install fails.
  }
}

/** Start this run with an empty log: the app shows its tail, and last run's
 *  failure would otherwise read as this run's. */
function resetGatewayLog() {
  const file = gatewayLogPath();
  if (!file) return;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '');
  } catch {
    // As above.
  }
}

const BOOT_LOG_NAME = 'boot.log';

/** Where the boot record goes; empty until a GATEWAY_DIR is known. */
let bootLogPath = '';
/** Line number in the record, so its order is readable without timestamps. */
let bootSeq = 0;

/**
 * The record of how far the boot got, for a death that leaves no other trace.
 *
 * `gateway.log` is written synchronously too, so it always reaches the line
 * before the crash — and that is the whole problem: the line after it, which
 * says *what* the process was doing when it died, is the one that never gets
 * written. On a phone this is not hypothetical: the payload unpacks, node
 * starts the server entry, and the app is simply gone — no `FAILED:`, no
 * stack, no exit code. Android's own exit history says why it was killed, but
 * not where.
 *
 * So each step is written *before* it is taken, to its own file, with an
 * fsync: a native abort or an OOM kill cannot flush anything on the way out,
 * and an unflushed write is a write that never happened. The last line of this
 * file is then a reliable answer to "how far did it get", which is the
 * question every other channel fails to answer in exactly this failure.
 *
 * It is deliberately tiny and self-contained: no imports beyond node:fs, no
 * dependencies on anything that might be the thing that is broken.
 */
function bootTrace(step) {
  if (!bootLogPath) return;
  bootSeq += 1;
  const line = `${String(bootSeq).padStart(2, '0')} ${step}\n`;
  try {
    // Open, write, flush, close — every time. appendFileSync would coalesce in
    // a buffer, which is exactly what a killed process loses.
    const fd = openSync(bootLogPath, 'a');
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Diagnostics must never be the reason a boot fails.
  }
  // Mirror into the gateway log, where the app already looks, with the same
  // `[gateway]` shape the parser expects to skip over.
  appendToGatewayLog(`[gateway] boot: ${step}`);
}

/** Start a fresh record in `dir`, and record the ways this process can end. */
/**
 * The steps of the previous run, read before this one overwrites the record.
 *
 * `boot.log` is written ahead of each step and fsynced, so after a crash its
 * last line is the step the process was taking when it died. Reading it back
 * is what lets a boot act on its own crash instead of repeating it.
 */
function readPreviousBoot(dir) {
  try {
    return readFileSync(path.join(dir, BOOT_LOG_NAME), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-40);
  } catch {
    return [];
  }
}

function openBootLog(dir) {
  bootLogPath = path.join(dir, BOOT_LOG_NAME);
  bootSeq = 0;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(bootLogPath, '');
  } catch {
    bootLogPath = '';
    return;
  }

  // `exit` runs for an orderly end, including a `process.exit()` called from
  // inside the payload — a case that otherwise looks exactly like a crash.
  process.on('exit', (code) => bootTrace(`the process is exiting (code ${code})`));

  // A signalled end is catchable; SIGKILL is not, and neither is a native
  // abort. Those two are why the record is written ahead of the step.
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => {
      bootTrace(`asked to stop (${signal})`);
      // Recording must not change what the signal does: drop this handler and
      // raise it again so the default action still happens.
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  }

  // An uncaught error would otherwise end the process with the same silence as
  // a kill on some Android builds; here it lands in both logs first.
  process.on('uncaughtException', (err) => {
    bootTrace(`uncaught exception: ${err && err.stack ? err.stack : String(err)}`);
    fatal(err);
  });
  process.on('unhandledRejection', (reason) => {
    bootTrace(`unhandled rejection: ${reason && reason.stack ? reason.stack : String(reason)}`);
    fatal(reason);
  });
}

function log(...args) {
  const line = `[gateway] ${args.join(' ')}`;
  console.log(line);
  appendToGatewayLog(line);
}

function fatal(err) {
  const line = `[gateway] FAILED: ${err && err.stack ? err.stack : String(err)}`;
  console.error(line);
  appendToGatewayLog(line);
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

/** ELF e_machine values, for the CPUs a payload might have been built for. */
const ELF_MACHINES = { 0x03: 'x86', 0x28: 'arm', 0x3e: 'x86-64', 0xb7: 'arm64' };

/**
 * Create the cache directory Next.js probes for, before it is asked.
 *
 * Next's `getCacheDirectory()` does not know `process.platform === 'android'`:
 * on Android it requires `~/.cache` (or `XDG_CACHE_HOME`) to *already* exist, and
 * when it does not, loading the instrumentation hook throws
 * `Unsupported platform: android`. That hook is what starts the gateway's own
 * logging, so the failure surfaces as a bare `500 Internal Server Error` on every
 * request with nothing in the log — the worst kind of failure to diagnose from a
 * phone. The upstream CLI creates this directory before Next.js starts; a payload
 * booted from `server.js` has no CLI in front of it, so it happens here, before
 * the import rather than after it.
 *
 * Only reported when it had to be created: on every later boot the directory is
 * already there and there is nothing to say.
 */
function prepareCacheDirectory() {
  const home = process.env.HOME;
  const cache = process.env.XDG_CACHE_HOME || (home ? path.join(home, '.cache') : '');
  if (!cache) return;
  const existed = existsSync(cache);
  try {
    mkdirSync(cache, { recursive: true });
    // Set as well as create: a cache directory Next does not know about is only
    // half the fix, and upstream's CLI sets this for the same reason.
    if (!process.env.XDG_CACHE_HOME) process.env.XDG_CACHE_HOME = cache;
    if (!existed) log(`created the cache directory ${cache} (Next.js requires it on Android)`);
  } catch (err) {
    log(`warning: could not create the cache directory ${cache}: ${err.message}`);
  }
}

/**
 * Markers of a libc Android does not have.
 *
 * Android's libc is Bionic, and it is not glibc or musl: a shared library linked
 * against either is refused by the dynamic linker, however right its CPU is. The
 * symbols below are what such a library always carries — `GLIBC_2.x` version
 * references in a glibc binary, a `libc.musl-…` dependency in a musl one — and
 * an Android-built library has neither.
 */
const LIBC_MARKERS = [
  { marker: 'GLIBC_', flavour: 'glibc' },
  { marker: 'libc.musl-', flavour: 'musl' },
];

/** Where a clean pass is remembered, so the scan is not repeated every boot. */
const NATIVE_CHECK_NAME = 'native-check.json';

/**
 * Nothing above this is scanned. A full pass runs before every boot, and a
 * phone's storage is slow: the libraries that matter are a few megabytes each.
 */
const LIBC_SCAN_FILE_LIMIT = 32 * 1024 * 1024;
/** Total bytes the scan may read per boot, across all libraries. */
const LIBC_SCAN_BUDGET = 256 * 1024 * 1024;
/** Chunk size for the scan, with an overlap so a marker split across two reads is still found. */
const LIBC_CHUNK_BYTES = 4 * 1024 * 1024;
const LIBC_OVERLAP = 32;

/**
 * The libc an ELF file was linked against, when it is one Android cannot use.
 *
 * Scanned rather than parsed: the marker lives in the dynamic string table, and
 * finding the table means walking section headers and their offsets — a great
 * deal of code to read four bytes of it. A substring search over the file finds
 * the same thing, and the file only has to be read once.
 */
function libcFlavour(file) {
  try {
    const fd = openSync(file, 'r');
    try {
      const chunk = Buffer.alloc(LIBC_CHUNK_BYTES + LIBC_OVERLAP);
      let offset = 0;
      for (;;) {
        const read = readSync(fd, chunk, 0, LIBC_CHUNK_BYTES + LIBC_OVERLAP, offset);
        if (read <= 0) return null;
        // latin1 maps one byte to one character, so a marker can never be split
        // by the decoding itself — only by the chunk boundary, which the overlap
        // covers.
        const text = chunk.toString('latin1', 0, read);
        for (const { marker, flavour } of LIBC_MARKERS) {
          if (text.includes(marker)) return flavour;
        }
        if (read <= LIBC_OVERLAP) return null;
        offset += LIBC_CHUNK_BYTES;
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * The payload's natively-backed dependencies, resolved by name.
 *
 * `require.resolve` — not `require` — on purpose: it reads package.json and
 * locates the entry file without loading anything, so this cannot dlopen a
 * library and cannot be the thing that crashes the boot it is reporting on.
 *
 * What it buys is a sentence the app could otherwise only guess at. When a
 * payload needs a native module the phone cannot load, the failure surfaces
 * wherever that module was first required — often inside a background task
 * nobody is watching — and the boot dies with no explanation. Naming them up
 * front, before the boot, makes "which feature is degraded" a fact in the log.
 */
const NATIVE_MODULES = [
  'sharp',
  'better-sqlite3',
  'onnxruntime-node',
  'wreq-js',
  'reqwest',
  'tls-client-node',
  '@ngrok/ngrok',
  'keytar',
];

function probeNativeModules(appDir) {
  // The path does not have to exist: createRequire only needs a file name to
  // resolve from, and the payload's own directory is the right place to resolve
  // from — node_modules inside it is what the payload loads.
  const from = createRequire(path.join(appDir, 'server.js'));
  const found = [];
  const missing = [];
  const esmOnly = [];
  for (const name of NATIVE_MODULES) {
    try {
      from.resolve(name);
      found.push(name);
    } catch (err) {
      // An ESM-only package cannot be resolved by a `require`, which is not the
      // same thing as not being there — saying so avoids a false alarm.
      if (err && err.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') esmOnly.push(name);
      else missing.push(name);
    }
  }
  log(
    `native modules in the payload: ${found.length} of ${NATIVE_MODULES.length} resolvable` +
      (missing.length ? `; not found: ${missing.join(', ')}` : '') +
      (esmOnly.length ? `; import-only: ${esmOnly.join(', ')}` : '')
  );
}

/**
 * The addons whose absence the gateway is known to survive: accelerators and
 * integrations, none of them the database.
 *
 * This list does NOT decide what gets disabled — a file a fatal signal has been
 * traced to is moved aside whether or not it appears here, because a boot that
 * starts beats a boot that loops. It decides only how the log line reads, so a
 * reader can tell "an optional accelerator came out" from "something required had
 * to come out, and the payload may now complain about it".
 */
const OPTIONAL_ADDONS = /(sharp|onnxruntime|@ngrok|keytar|wreq|reqwest|tls-client|requestws)/i;

const NATIVE_PROBE_FILE = 'native-probe.json';

/**
 * What is already known about this install's addons.
 *
 * `ok` is the load-once list: a module proven to load is never loaded again, so
 * the probe's cost is paid once per payload rather than once per boot.
 * `installedAt` ties the record to a payload: a new install invalidates it.
 */
function nativeProbeState(gatewayDir, installedAt) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(gatewayDir, NATIVE_PROBE_FILE), 'utf8'));
    if (parsed && (parsed.installedAt ?? null) === (installedAt ?? null)) {
      return {
        installedAt: parsed.installedAt ?? null,
        ok: Array.isArray(parsed.ok) ? parsed.ok : [],
        disabled: Array.isArray(parsed.disabled) ? parsed.disabled : [],
      };
    }
  } catch {
    // No record yet, or an unreadable one: a fresh start is the safe reading.
  }
  return { installedAt: installedAt ?? null, ok: [], disabled: [] };
}

function saveNativeProbeState(gatewayDir, state) {
  try {
    writeFileSync(path.join(gatewayDir, NATIVE_PROBE_FILE), JSON.stringify(state, null, 2));
  } catch {
    // Bookkeeping must never be the reason a boot fails.
  }
}

/** Every native addon in the payload, as a path relative to it. */
function findNativeAddons(appDir, limit = 150) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 8 || found.length >= limit) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // `.bin` holds CLI shims, `.cache` holds build scratch; neither is loaded.
        // Nested `node_modules` are walked like any other directory.
        if (entry.name === '.bin' || entry.name === '.cache') continue;
        walk(full, depth + 1);
      } else if (entry.name.endsWith('.node') && !entry.name.endsWith('.disabled')) {
        found.push(path.relative(appDir, full));
      }
    }
  };
  walk(path.join(appDir, 'node_modules'), 0);
  return found.sort();
}

/**
 * Load the payload's native addons one at a time, and name the one that dies.
 *
 * This is the answer to a failure that has no other evidence. A SIGSEGV inside
 * a native library kills the process between two instructions: no stack, no
 * exit line, nothing — on the device the gateway simply vanished just after
 * `loading server.js`. The Kotlin side can ask Android for the crash dump, but
 * that dump is not always there (a fatal signal that the crash handler did not
 * claim arrives as REASON_SIGNALED with no trace), so the app needs a signal
 * that cannot be missing.
 *
 * Writing the name *before* each load is that signal: `bootTrace` fsyncs, so the
 * last line of `boot.log` names the addon that was being loaded when the process
 * died. On the next boot the same line is read back, the addon is disabled if it
 * is optional, and the boot continues past it.
 */
async function probeNativeAddons({ appDir, gatewayDir, previousBoot, installedAt }) {
  const state = nativeProbeState(gatewayDir, installedAt);
  const addons = findNativeAddons(appDir);
  if (!addons.length) return;

  // 1. Did the previous boot die while loading one of them?
  const lastProbe = [...previousBoot].reverse().find((line) => line.includes(' probing '));
  const diedIn =
    lastProbe && lastProbe.includes(' probing ')
      ? lastProbe.slice(lastProbe.indexOf(' probing ') + ' probing '.length).trim()
      : '';

  if (diedIn && addons.includes(diedIn)) {
    // Moved aside whatever it is, and that is the point. Keeping a file that a
    // fatal signal has already been traced to means restarting into the same
    // crash for ever, which is precisely the state this exists to end — the
    // device restarted into it a dozen times with nothing to read afterwards.
    // Which addon it is decides only how the line reads: an accelerator the
    // gateway has a slower path without, or something unrecognised that had to
    // go anyway. Either way the gateway starting beats the gateway looping, and
    // the log says exactly what was removed so it can be put back by hand.
    const optional = OPTIONAL_ADDONS.test(diedIn);
    const file = path.join(appDir, diedIn);
    try {
      await fs.rename(file, `${file}.disabled`);
      if (!state.disabled.includes(diedIn)) state.disabled.push(diedIn);
      saveNativeProbeState(gatewayDir, state);
      log(
        `native addon probe: ${diedIn} killed the previous boot (${optional ? 'a known-optional accelerator' : 'not one of the known-optional addons'}) — renamed to .disabled so the gateway can start`
      );
    } catch (err) {
      log(`warning: could not disable ${diedIn}, so it may kill the next boot too: ${err.message}`);
    }
  }

  if (state.disabled.length) {
    log(`native addon probe: disabled for this install: ${state.disabled.join(', ')}`);
  }

  const remaining = addons.filter((rel) => !state.ok.includes(rel) && !state.disabled.includes(rel));
  if (!remaining.length) return;

  // 2. A boot that came up needs no probe: this runs only while something is
  //    wrong, which is also what keeps it off the happy path.
  if (previousBoot.some((line) => line.includes('the server is answering'))) return;

  const from = createRequire(path.join(appDir, 'server.js'));
  let loaded = 0;
  let refused = 0;
  for (const rel of remaining) {
    // Before the load, fsynced: if this is the one that kills the process, this
    // line is what survives, and the next boot reads it.
    bootTrace(`probing ${rel}`);
    try {
      from(path.join(appDir, rel));
      loaded += 1;
      state.ok.push(rel);
      saveNativeProbeState(gatewayDir, state);
    } catch (err) {
      // A refused load is information, not a failure to recover from: the addon
      // is missing a dependency or was built for another libc, and the payload's
      // JS wrapper is what normally reports that. Only a *crash* disables one.
      refused += 1;
      log(`native addon probe: ${rel} would not load (${err?.code || err?.message || 'unknown'})`);
    }
  }
  log(`native addon probe: ${loaded} loaded, ${refused} refused, ${state.disabled.length} disabled`);
}

function machineName(code) {
  return ELF_MACHINES[code] ?? `0x${code.toString(16)}`;
}

/**
 * The CPU an ELF binary was built for, or null when the file is not readable ELF.
 *
 * The payload is assembled on a GitHub runner (x86-64) from a Next.js build whose
 * `standalone` output copies whichever prebuilt native modules npm installed
 * there. Nothing in that pipeline knows the phone is arm64: a `sharp` or
 * `onnxruntime` binary built for the runner's CPU travels to the phone inside the
 * payload, and what happens when something loads it is a native crash — the app
 * simply disappears, with nothing in any log. Reading 20 bytes of each library is
 * cheap enough to do before every boot, and it is the difference between "node
 * crashed" and "this file is for the wrong CPU".
 */
function elfMachine(file) {
  try {
    const fd = openSync(file, 'r');
    try {
      const header = Buffer.alloc(20);
      if (readSync(fd, header, 0, 20, 0) < 20) return null;
      // 0x7f 'E' 'L' 'F'
      if (header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46) return null;
      return header.readUInt16LE(18);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Unreadable, or not a regular file: not our business here.
    return null;
  }
}

/**
 * Move native libraries built for another CPU out of the payload.
 *
 * A library for the wrong CPU cannot load on this phone: the first `require()`
 * that touches it kills the process with a SIGSEGV and writes nothing at all —
 * measured on a real device, where 29 of the payload's 63 libraries were x86-64
 * because the payload is assembled on an x86-64 runner. Reporting that is not
 * enough: the crash still happens, one step later, with no way to tell which
 * file did it.
 *
 * So they are moved aside, into `wrong-arch/` beside the install. What replaces
 * them is whatever the payload already does without them — upstream treats most
 * of these as optional and warns — or a plain `Cannot find module`, which prints
 * and which the app can show. Either is a gateway that says what is missing
 * instead of an app that disappears.
 *
 * Deliberately not a refusal: a foreign library that nothing loads is harmless,
 * and this runs before every boot. It leaves the tree alone once the files are
 * gone, so the common case costs one line in the log.
 */
async function quarantineForeignLibraries(appDir, quarantineDir, installedAt) {
  // A clean pass is remembered, because this runs before *every* boot and the
  // rest of it is a scan over tens of thousands of files on a phone's storage.
  // The installed tree cannot change between boots of the same install — a new
  // payload rewrites the marker, and its timestamp is what the stamp is keyed
  // on — so a second identical scan can only produce the same answer.
  //
  // A pass that *moved* something is deliberately not remembered: the next boot
  // re-checks that the files really left, and that pass is cheap because they
  // are gone.
  const stampPath = process.env.GATEWAY_DIR ? path.join(process.env.GATEWAY_DIR, NATIVE_CHECK_NAME) : '';
  if (installedAt && stampPath) {
    try {
      const stamp = JSON.parse(readFileSync(stampPath, 'utf8'));
      if (stamp.installedAt === installedAt && stamp.removed === 0) {
        log(`native libraries in the payload: already checked for this install (${stamp.checkedAt})`);
        return;
      }
    } catch {
      // No stamp, or an unreadable one: check the payload. Never the other way
      // round — a missing stamp must not be read as "clean".
    }
  }

  const expected = process.arch === 'arm64' ? 0xb7 : process.arch === 'x64' ? 0x3e : null;
  const binaries = [];
  const queue = [appDir];
  let visited = 0;
  while (queue.length && visited < 120_000) {
    const dir = queue.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Nothing native lives in these, and they are where the huge trees are.
        if (entry.name !== '.cache' && entry.name !== '.git') queue.push(full);
      } else if (entry.name.endsWith('.node') || entry.name.endsWith('.so')) {
        binaries.push({ file: full, machine: elfMachine(full) });
      }
    }
  }

  if (!binaries.length) {
    log('native libraries in the payload: none');
    return;
  }

  // Two reasons a library in the payload can never load on this phone:
  //
  //   - it was built for another CPU (the payload is assembled on an x86-64
  //     runner), or
  //   - it was built for a desktop libc — Android's is Bionic, and a glibc or
  //     musl binary is refused outright, however right its CPU is.
  //
  // Both are decided here, before the boot, because both fail *during* it: the
  // first is a crash with no output, the second an error thrown wherever the
  // library happened to be required.
  const wrongArch =
    expected === null ? [] : binaries.filter((item) => item.machine !== null && item.machine !== expected);
  const candidates = binaries.filter((item) => item.machine !== null && !wrongArch.includes(item));
  let budget = LIBC_SCAN_BUDGET;
  let unscanned = 0;
  for (const item of candidates) {
    const size = fileSize(item.file);
    if (size > LIBC_SCAN_FILE_LIMIT || size > budget) {
      unscanned += 1;
      continue;
    }
    budget -= size;
    item.libc = libcFlavour(item.file);
  }
  const wrongLibc = candidates.filter((item) => item.libc);
  const unloadable = [...wrongArch, ...wrongLibc];

  if (!unloadable.length) {
    const unreadable = binaries.length - binaries.filter((item) => item.machine !== null).length;
    if (installedAt && stampPath) {
      try {
        writeFileSync(
          stampPath,
          JSON.stringify({ installedAt, checkedAt: new Date().toISOString(), removed: 0, libraries: binaries.length })
        );
      } catch {
        // The stamp is an optimisation; failing to write it costs a rescan.
      }
    }
    // Unreadable and unscanned files are not a clean bill of health, so they are
    // counted rather than folded into "all good".
    log(
      `native libraries in the payload: ${binaries.length} checked, ${candidates.length} usable on this phone ` +
        `(${process.arch}, Bionic)` +
        (unreadable ? `, ${unreadable} unreadable` : '') +
        (unscanned ? `, ${unscanned} too big to check` : '')
    );
    return;
  }

  const reasonFor = (item) => (item.libc ? `desktop ${item.libc}` : machineName(item.machine));
  const moved = [];
  const failed = [];
  for (const item of unloadable) {
    const relative = path.relative(appDir, item.file);
    const destination = path.join(quarantineDir, relative);
    try {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.rename(item.file, destination);
      moved.push(relative);
    } catch (err) {
      failed.push(`${relative} (${err.message})`);
    }
  }

  const named = moved
    .slice(0, 3)
    .map((file) => {
      const item = unloadable.find((candidate) => path.relative(appDir, candidate.file) === file);
      return `${file} (${reasonFor(item)})`;
    })
    .join(', ');
  if (moved.length) {
    log(
      `moved ${moved.length} of ${binaries.length} native libraries out of the payload — they cannot load on this ` +
        `phone (${wrongArch.length} for another CPU, ${wrongLibc.length} for a desktop libc), and loading one is a ` +
        `crash, or an error where nothing is watching: ${named}`
    );
  }
  if (failed.length) {
    // Left in place they are still a crash waiting to happen, so this is worth
    // saying loudly even though the move itself is best-effort.
    log(
      `warning: could not move ${failed.length} native libraries that cannot load on this phone: ` +
        `${failed.join(', ')} — a boot that touches one will crash with no output`
    );
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
  // tar pads every record — metadata and file bodies alike — to 512 bytes.
  const skipPadding = async (size) => {
    const padding = (512 - (size % 512)) % 512;
    if (padding) await reader.skip(padding);
  };

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

    // Metadata entries (pax, GNU long name) carry a body that is *not* a file
    // body — but it is still padded to a 512-byte boundary, and forgetting that
    // padding desynchronises the whole stream from here on. (It fails loudly
    // but confusingly: entries start being read from mid-record, and the first
    // symptom is something like "EISDIR ... open <extract-dir>".)
    if (type === 'x' || type === 'g') {
      const data = await reader.read(size);
      await skipPadding(size);
      pendingPax = { ...(pendingPax ?? {}), ...parsePax(data) };
      // pax records override the ustar header fields for the next entry.
      continue;
    }

    if (type === 'L') {
      // GNU long name: the body is the name of the *next* entry.
      const data = await reader.read(size);
      await skipPadding(size);
      pendingLongName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }

    if (pendingPax && pendingPax.path) {
      name = pendingPax.path;
    }
    pendingPax = null;

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

    await skipPadding(size);
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

/**
 * Fetch the expected checksum from a URL, when the app did not pin one.
 *
 * Accepts either the payload manifest this repo's CI publishes next to the
 * archive (`{"sha256": "…"}`) or a bare hex digest.
 *
 * Be honest about what this buys: it is checked *after* the download, from the
 * same host that served it, so it catches a truncated or corrupted 100+ MB
 * transfer — the realistic failure — and not a host that has been tampered
 * with. Pinning `GATEWAY_PAYLOAD_SHA256` in the app is what protects against
 * that, at the cost of having to ship a new app when the payload changes.
 */
async function fetchExpectedSha256(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`checksum URL returned HTTP ${response.status}`);
  const text = (await response.text()).trim();
  let candidate = text;
  if (text.startsWith('{')) {
    try {
      candidate = String(JSON.parse(text).sha256 ?? '').trim();
    } catch {
      throw new Error('checksum URL returned malformed JSON');
    }
  }
  const sha = candidate.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) {
    throw new Error(`checksum URL did not contain a sha256 digest (got ${text.slice(0, 40)}…)`);
  }
  return sha;
}

async function download(url, destPath) {
  const already = fileSize(destPath);
  const resuming = already > 0;
  log(`downloading ${url}`);
  if (resuming) log(`resuming the download at ${mb(already)}`);

  const controller = new AbortController();
  let stalled = false;
  let timer = null;
  const armStall = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, STALL_MS);
  };

  armStall();
  let response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: resuming ? { range: `bytes=${already}-` } : undefined,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(stalled ? stallMessage(already) : `download failed: ${err.message}`);
  }

  if (!response.ok) {
    clearTimeout(timer);
    // 403/404 here means the host would not serve this file to this network at
    // all — different advice from a timeout, and worth saying out loud.
    const hint =
      response.status === 403 || response.status === 404
        ? ' — GitHub would not serve this file to this network. Try again on another Wi-Fi or mobile connection.'
        : '';
    throw new Error(`download failed: HTTP ${response.status} ${response.statusText} for ${url}${hint}`);
  }
  if (!response.body) {
    clearTimeout(timer);
    throw new Error('download failed: empty response body');
  }

  // Where the bytes in this response start. A 206 means the server agreed to
  // continue; anything else means it sent the whole file, so what is on disk is
  // scrap and the sink has to truncate rather than append.
  const contentRange = response.headers.get('content-range') || '';
  const rangeTotal = Number(contentRange.split('/')[1] || 0);
  const contentLength = Number(response.headers.get('content-length') || 0);
  let start = 0;
  if (resuming && response.status === 206) {
    const from = Number((contentRange.split(' ')[1] || '').split('-')[0]);
    if (Number.isFinite(from) && from === already) {
      start = already;
    } else {
      log('the server resumed at a different offset; starting over');
    }
  } else if (resuming) {
    log('the server sent the whole file instead of a range; starting over');
  }

  const total = rangeTotal || start + contentLength;
  if (total) log(`payload is ${mb(total)}`);

  // Refuse before writing a byte if the phone cannot hold both the archive and
  // what comes out of it. Failing here is clear ("needs 2.3 GB, has 800 MB");
  // failing halfway through an unpack is a mystery, and it costs the user the
  // one runtime start this app session gets.
  const needed = total ? Math.round(total * 3) : MIN_FREE_BYTES;
  const free = freeBytes(path.dirname(destPath));
  if (free !== null) {
    log(`free space ${mb(free)}, need about ${(needed / (1024 * 1024)).toFixed(0)} MB`);
    if (free < needed) {
      throw new Error(
        `not enough free space for the ${(total / (1024 * 1024)).toFixed(0)} MB payload: ` +
          `${(free / (1024 * 1024)).toFixed(0)} MB free, about ${(needed / (1024 * 1024)).toFixed(0)} MB needed ` +
          `(the archive plus what it unpacks into). Free up space and try again.`
      );
    }
  }

  let received = start;
  let lastProgress = Math.floor(start / PROGRESS_BYTES);
  const body = Readable.fromWeb(response.body);
  body.on('data', (chunk) => {
    received += chunk.length;
    armStall();
    const step = Math.floor(received / PROGRESS_BYTES);
    if (step > lastProgress) {
      lastProgress = step;
      const percent = total ? ` (${((received / total) * 100).toFixed(0)}%)` : '';
      log(`downloaded ${mb(received)}${percent}`);
    }
  });

  try {
    // Append when continuing an earlier attempt, truncate otherwise.
    await pipeline(body, createWriteStream(destPath, start > 0 ? { flags: 'a' } : undefined));
  } catch (err) {
    if (stalled) throw new Error(stallMessage(received));
    throw new Error(`download failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  // A short body that ends without an error (a proxy cutting the stream) would
  // otherwise reach the extractor, which fails somewhere far less clear.
  if (total && received !== total) {
    throw new Error(
      `download ended early: got ${mb(received)} of ${mb(total)} — start it again to resume`
    );
  }

  log(`downloaded ${mb(received)}`);
  return received;
}

/**
 * Try the download a few times before giving up.
 *
 * Anything that looks transient — a timeout, a dropped socket, a 5xx, a body
 * that ended early — is worth another attempt, because another attempt resumes
 * rather than restarts. A 4xx is not: the server has answered, and it will
 * answer the same way. 408 and 429 are the exceptions, being explicitly about
 * trying again.
 */
async function downloadWithRetries(url, destPath, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await download(url, destPath);
    } catch (err) {
      const clientError = /HTTP 4\d\d/.test(err.message) && !/HTTP (408|429)/.test(err.message);
      if (clientError || attempt >= attempts) throw err;
      log(`download attempt ${attempt} failed (${err.message}) — retrying`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
}

/**
 * Said when bytes simply stop arriving.
 *
 * It has to say "try again", because that is now genuinely cheap: the partial
 * file is kept and the next attempt continues from it.
 */
function stallMessage(received) {
  return (
    `download stalled after ${mb(received)} — nothing arrived for ${Math.round(STALL_MS / 1000)}s. ` +
    `Start it again: the download resumes from where it stopped.`
  );
}

function pickEntry(preferred, candidates) {
  const order = preferred ? [preferred, ...candidates.filter((c) => c !== preferred)] : candidates;
  for (const candidate of order) {
    if (entryExists(candidate)) return candidate;
  }
  return order[0];
}

// Set once the install directory is known, so pickEntry can look at the payload.
let installedAppDir = '';
function entryExists(entry) {
  return Boolean(installedAppDir) && existsSync(path.join(installedAppDir, entry));
}

/**
 * Find the directory inside an extracted payload that holds the entry script.
 *
 * Tarballs do not agree on roots: a hand-rolled bundle puts `dist/server.js` at
 * the top, while `npm pack` nests everything under `package/`. Accept either —
 * exactly one level of nesting, and only when it is unambiguous.
 */
async function resolveAppRoot(staging, entries) {
  const has = (dir) => entries.some((entry) => existsSync(path.join(dir, entry)));
  if (has(staging)) return staging;
  const top = (await fs.readdir(staging, { withFileTypes: true })).filter((item) => item.isDirectory());
  const matches = top.filter((item) => has(path.join(staging, item.name)));
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
  // Printed before anything else can fail, so an empty log means the script
  // never got this far — a different problem from a gateway that failed to
  // install, and one the app can only guess at otherwise.
  resetGatewayLog();
  log(`starting on node ${process.version} (pid ${process.pid})`);

  const gatewayDir = process.env.GATEWAY_DIR;
  if (!gatewayDir) fatal(new Error('GATEWAY_DIR is required'));

  // Before the install, not just before the boot: a payload that dies while
  // unpacking (a full disk, a killed process) leaves the same silence.
  // Read *before* openBootLog truncates it: the previous run's record is how a
  // boot knows what killed it, and it is the only channel that survives a native
  // crash — nothing is flushed on the way out.
  const previousBoot = readPreviousBoot(gatewayDir);
  openBootLog(gatewayDir);
  bootTrace(`runtime ready on node ${process.version} (pid ${process.pid})`);

  // Before anything Next.js is loaded: see prepareCacheDirectory.
  prepareCacheDirectory();

  const appDir = path.join(gatewayDir, 'app');
  // Two payload shapes are in play: a packaged `npm` tree (entry
  // dist/server.js) and a Next `output: 'standalone'` tree (entry server.js).
  // Try the configured one first, then the other, so a mismatch here is a
  // non-event rather than an install that fails at the last step.
  const entries = ['dist/server.js', 'server.js'];
  let entry = pickEntry(process.env.GATEWAY_ENTRY || '', entries);
  const url = process.env.GATEWAY_PAYLOAD_URL || '';
  let expectedSha = (process.env.GATEWAY_PAYLOAD_SHA256 || '').trim().toLowerCase();
  const shaUrl = (process.env.GATEWAY_PAYLOAD_SHA256_URL || '').trim();
  const force = process.env.GATEWAY_FORCE_INSTALL === '1';

  await fs.mkdir(gatewayDir, { recursive: true });

  const marker = await readMarker(gatewayDir);
  installedAppDir = appDir;
  const installed = entries.some((candidate) => existsSync(path.join(appDir, candidate)));
  const markerMatches = Boolean(marker) && (!expectedSha || marker.sha256 === expectedSha);
  const upToDate = installed && markerMatches && !force;

  if (upToDate) {
    log(`gateway already installed at ${appDir}${marker?.installedAt ? ` (${marker.installedAt})` : ''}`);
    // Nothing to install, but the entry still has to point at a real file: an
    // older install may predate the current payload shape.
    entry = pickEntry(process.env.GATEWAY_ENTRY || '', entries);
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

    bootTrace('installing the payload');
    const tarballPath = path.join(gatewayDir, PAYLOAD_NAME);
    const partPath = `${tarballPath}.part`;

    if (!expectedSha && shaUrl) {
      try {
        log('fetching the expected checksum…');
        expectedSha = await fetchExpectedSha256(shaUrl);
        log(`expected ${expectedSha.slice(0, 16)}…`);
      } catch (err) {
        // Not fatal, on purpose. The manifest is served from the same host as the
        // payload, so it guards against corruption in transit rather than against
        // a hostile publisher — and gzip's own CRC catches most corruption
        // anyway. Refusing to install at all because a *checksum* URL is
        // unreachable (a filtered network, a captive portal, a 404, a flaky
        // proxy) turns defence-in-depth into an outage: a real phone hit exactly
        // this and could not install a payload it was able to download. A
        // manifest that *was* fetched and does not match stays fatal, below.
        expectedSha = '';
        log(
          `warning: no checksum available (the manifest at ${shaUrl} could not be fetched: ${err.message}) — installing without integrity verification`
        );
      }
    }

    try {
      // A previous run may have downloaded the payload and failed later (an
      // interrupted extract, a killed app). Re-downloading 700+ MB to get to the
      // same bytes is a poor use of someone's mobile data — and a download that
      // died halfway is resumed, not restarted, from the .part file below.
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
        await downloadWithRetries(url, partPath);

        if (expectedSha) {
          log('verifying checksum…');
          const actualSha = await sha256File(partPath);
          if (actualSha !== expectedSha) {
            // Marked so the cleanup below deletes it: a payload that failed
            // verification is known bad, and resuming from it would download
            // the rest of a file that can never verify.
            const mismatch = new Error(`checksum mismatch: expected ${expectedSha}, got ${actualSha}`);
            mismatch.badPayload = true;
            throw mismatch;
          }
          log('checksum ok');
        } else {
          // Kept as a single literal on purpose: scripts/check-gateway-log.mjs
          // matches this text against the parser, and a split literal would
          // silently escape that check.
          log(
            'warning: no checksum available (GATEWAY_PAYLOAD_SHA256 and GATEWAY_PAYLOAD_SHA256_URL are both unset) — installing without integrity verification'
          );
        }

        await fs.rename(partPath, tarballPath);
      }

      // Extract beside the live directory and swap, so a crash mid-extract does
      // not leave a half-written app that looks installed.
      const staging = path.join(gatewayDir, 'app.new');
      await fs.rm(staging, { recursive: true, force: true });
      await extractTarGz(tarballPath, staging);

      const appRoot = await resolveAppRoot(staging, entries);
      if (!entries.some((candidate) => existsSync(path.join(appRoot, candidate)))) {
        throw new Error(
          `payload contains none of: ${entries.join(', ')} (is this a gateway bundle?)`
        );
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

      // Now that the payload is in place, fix up which entry actually exists.
      const resolved = pickEntry(process.env.GATEWAY_ENTRY || '', entries);
      if (resolved !== entry) log(`entry is ${resolved} (not ${entry})`);
      entry = resolved;

      await fs.writeFile(
        path.join(gatewayDir, MARKER),
        JSON.stringify({ url, sha256: expectedSha || null, installedAt: new Date().toISOString() }, null, 2)
      );
      // The tarball has served its purpose; keeping it doubles the footprint.
      await fs.rm(tarballPath, { force: true });
      bootTrace('the payload is installed');
      log('install complete');
    } catch (err) {
      // Keep a partial download: it is the resume point for the next attempt.
      // Only a payload that failed *verification* is deleted — it is known bad,
      // and resuming from it could never succeed.
      if (err && err.badPayload) await fs.rm(partPath, { force: true }).catch(() => {});
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
  // Written before the import, because this is the step the app has been seen
  // to die in — and a process that dies here prints nothing at all.
  // Before the boot, because a wrong-arch library is a crash that happens *during*
  // the boot, and moving it out of the way is the only thing that prevents it.
  try {
    await quarantineForeignLibraries(appDir, path.join(gatewayDir, 'wrong-arch'), marker?.installedAt ?? null);
  } catch (err) {
    log(`warning: could not check the payload's native libraries: ${err.message}`);
  }
  // Which of the payload's natively-backed dependencies it can actually find,
  // named before the boot that would otherwise fail around one of them.
  try {
    probeNativeModules(appDir);
  } catch (err) {
    log(`warning: could not check the payload's native modules: ${err.message}`);
  }

  // Then the addons themselves, by name, when the last boot did not come up: a
  // crash here has no stack, so the line written before each load is the
  // evidence — and an optional addon that died is disabled rather than kept.
  try {
    await probeNativeAddons({ appDir, gatewayDir, previousBoot, installedAt: marker?.installedAt ?? null });
  } catch (err) {
    log(`warning: the native addon probe could not run: ${err.message}`);
  }

  bootTrace(`loading ${entry}`);
  try {
    await import(pathToFileURL(serverEntry).href);
  } catch (err) {
    fatal(err);
  }
  bootTrace(`${entry} loaded; waiting for the server to answer`);

  // The module is loaded. From here on nothing in this process writes to the
  // gateway's log unless something goes wrong, so "did the server come up?" is
  // otherwise unanswerable from the log alone — and on a phone the answer has to
  // survive the process being killed, because that is exactly when someone asks.
  log(`${entry} loaded; waiting for ${process.env.HOSTNAME}:${process.env.PORT} to answer`);

  // Ask the server itself, and say so in the log. The app polls the same URL, so
  // this is redundant for the UI and deliberate for the record: a crash report
  // should say whether the server ever answered.
  const healthUrl = `http://${process.env.HOSTNAME}:${process.env.PORT}/healthz`;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      const res = await fetch(healthUrl);
      if (res.ok) {
        bootTrace('the server is answering');
        log(`the server is answering on ${healthUrl}`);
        return;
      }
    } catch {
      // Not up yet. Keep waiting quietly: this is normal for a first boot.
    }
  }
  bootTrace('the server never answered');
  log(`warning: ${healthUrl} did not answer within ${Math.round(HEALTH_TIMEOUT_MS / 1000)}s`);
}

/**
 * The argv flag the app passes to say "run the installer".
 *
 * Path identity is not a reliable signal on Android: Node resolves symlinks
 * when it computes `import.meta.url`, while `argv[1]` keeps whatever the caller
 * typed — and Android's app-data paths are symlinks of each other
 * (`/data/data` ⇄ `/data/user/0`). Comparing the two strings therefore came out
 * false on a real phone, where the script loaded, `main()` was never called and
 * the process exited 0 with an empty log: the app could only report a crash
 * that had not happened, and 17 minutes of build time bought nothing.
 * The flag takes the filesystem out of the question.
 */
export const RUN_FLAG = '--gateway-run';

/** Is this module the program being run, rather than an import? */
function invokedAsProgram() {
  if (process.argv.includes(RUN_FLAG)) return true;
  if (!process.argv[1]) return false;
  // realpath() on both sides — see RUN_FLAG above.
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// Only install+boot when run as a program: importing this module (from a test,
// say) must not start downloading things.
if (invokedAsProgram()) main().catch(fatal);

export { extractTarGz, sha256File, parsePax };
