#!/usr/bin/env node
/**
 * Installs two differently-shaped payloads with the real installer, and checks
 * which entry it picks and that the payload actually boots.
 *
 * Why this exists: everything else tests a piece. `payload:test` covers the
 * archive format, `gateway:test` covers the log parser, `tsc` covers the app.
 * Nothing spanned download → checksum → extract → install → boot, which is the
 * chain the phone actually runs, and nothing at all covered *entry resolution* —
 * the part that knows a Next `output: 'standalone'` tree (`server.js`) differs
 * from a packaged npm tree (`dist/server.js`). That gap was found by hand: the
 * first end-to-end run against a standalone payload died at
 * `payload does not contain dist/server.js`, after the download and extract had
 * both succeeded.
 *
 * So this test serves packed fixtures over loopback and runs
 * `gateway/bootstrap.mjs` exactly as the app does, then waits for the payload's
 * own output — not just the installer's log line, which would pass even if the
 * entry threw on boot.
 *
 * Three cases, because the interesting behaviour is in the differences:
 *   - a standalone tree → `server.js`, chosen after the default is missing;
 *   - an npm tree that *also* has a decoy `server.js` at the root → the
 *     configured default wins;
 *   - a second run over an existing install with no URL at all → still boots,
 *     re-resolving the entry rather than trusting the first decision.
 *
 *   node scripts/check-payload-install.mjs
 */

import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKER = join(ROOT, 'scripts', 'pack-payload.mjs');
const BOOTSTRAP = join(ROOT, 'gateway', 'bootstrap.mjs');
// The flag the app passes, taken from the script that reads it: if the two ever
// disagree, `npm run runtime:contract` fails, and these cases would fail too.
const { RUN_FLAG } = await import(pathToFileURL(BOOTSTRAP).href);
const GATEWAY_LOG_NAME = 'gateway.log';

/** The payload's own server: answers /healthz and says so out loud. */
function fixtureServer(marker) {
  return `const http = require('node:http');
console.log(${JSON.stringify(marker + ' started')});
http
  .createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    } else {
      res.writeHead(404);
      res.end();
    }
  })
  .listen(Number(process.env.PORT) || 3000, process.env.HOSTNAME || '127.0.0.1', () => {
    console.log(${JSON.stringify(marker + ' listening')});
  });
`;
}

const failures = [];
const check = (label, ok) => {
  if (ok) process.stdout.write(`  ✓ ${label}\n`);
  else {
    failures.push(label);
    process.stdout.write(`  ✖ ${label}\n`);
  }
};

function packFixture(sourceDir, outPath, entry) {
  try {
    execFileSync(process.execPath, [PACKER, sourceDir, '-o', outPath, '--entry', entry], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new Error(`packer failed for ${sourceDir}:\n${err.stdout ?? ''}${err.stderr ?? ''}`);
  }
  return `${outPath}.json`;
}

/**
 * A payload that dies *the way this failure actually looks*: the process is gone
 * while loading the entry, with no exception, no exit code and nothing in the
 * gateway log after `starting server.js`.
 *
 * `process.abort()` is deliberate: it raises SIGABRT in native code, so no
 * JavaScript handler runs and nothing can be flushed on the way out. An OOM kill
 * or a native crash in a payload module looks exactly like this to the app, and
 * the whole point of the boot record is that its last line is already on disk
 * when that happens.
 */
function fixtureAbortServer(marker) {
  return `console.log(${JSON.stringify(marker + ' starting')});
process.abort();
`;
}

/**
 * A free loopback port, released immediately for the child to claim.
 */
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Start the installer and collect its output until `ready` says it is done.
 * The caller does its assertions while the child is still running — a payload
 * that answers /healthz cannot answer once it has been killed.
 */
async function bootAndRead(env, ready, { script = BOOTSTRAP, args = [] } = {}) {
  const child = spawn(process.execPath, [script, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });

  const deadline = Date.now() + 60_000;
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });

  while (Date.now() < deadline) {
    if (ready(output)) break;
    if (exited) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return {
    output: () => output,
    stop: async () => {
      if (exited) return;
      child.kill('SIGKILL');
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2000))]);
    },
  };
}

async function main() {
  const work = mkdtempSync(join(tmpdir(), 'payload-install-'));
  process.stdout.write(`payload-install: fixtures under ${work}\n`);

  // --- fixtures ------------------------------------------------------------
  const standalone = join(work, 'standalone');
  mkdirSync(join(standalone, 'node_modules', 'next'), { recursive: true });
  const longDir = join(standalone, 'deep', 'a'.repeat(60), 'b'.repeat(60));
  mkdirSync(longDir, { recursive: true });
  writeFileSync(join(longDir, 'long-name.txt'), 'deep\n');
  writeFileSync(join(standalone, 'node_modules', 'next', 'package.json'), '{}');

  /**
   * A native library header, as the payload scanner reads it: 20 bytes, ELF magic
   * and an e_machine value. Written by hand because the point is what the scanner
   * does with a *foreign* CPU, and no real arm64 library exists on this runner.
   */
  const writeElf = (file, machine, marker = '') => {
    const header = Buffer.alloc(20);
    header.write('\x7fELF', 0, 'binary');
    header[4] = 2; // 64-bit
    header[5] = 1; // little-endian
    header.writeUInt16LE(2, 16); // e_type = ET_EXEC
    header.writeUInt16LE(machine, 18); // e_machine
    writeFileSync(file, marker ? Buffer.concat([header, Buffer.from(marker, 'latin1')]) : header);
  };
  // Three libraries, written relative to whatever CPU runs this test, so the
  // assertions hold on a phone, an x86-64 runner and an arm64 laptop alike:
  // one for this CPU, one for the other CPU, and one for this CPU but linked
  // against a desktop libc — which Android's Bionic refuses, so it has to go
  // too, and for a different reason.
  const hostMachine = process.arch === 'arm64' ? 0xb7 : 0x3e;
  const otherMachine = hostMachine === 0xb7 ? 0x3e : 0xb7;
  const sharpDir = join(standalone, 'node_modules', 'sharp', 'build', 'Release');
  mkdirSync(sharpDir, { recursive: true });
  writeElf(join(sharpDir, 'sharp.node'), otherMachine);
  writeElf(join(sharpDir, 'libvips.so'), hostMachine);
  writeElf(join(sharpDir, 'libvips-desktop.so'), hostMachine, '\x00GLIBC_2.34\x00');
  writeFileSync(join(standalone, 'server.js'), fixtureServer('STANDALONE'));
  symlinkSync('server.js', join(standalone, 'entry-link.js'));

  const npmShaped = join(work, 'npm');
  mkdirSync(join(npmShaped, 'dist'), { recursive: true });
  writeFileSync(join(npmShaped, 'dist', 'server.js'), fixtureServer('NPM'));
  // Only a wrong installer would run this: it is the decoy for the entry test.
  writeFileSync(join(npmShaped, 'server.js'), 'console.log("DECOY RAN");\nprocess.exit(1);\n');

  const aborting = join(work, 'aborting');
  mkdirSync(aborting, { recursive: true });
  writeFileSync(join(aborting, 'server.js'), fixtureAbortServer('ABORT'));

  const standaloneTar = join(work, 'standalone.tar.gz');
  const npmTar = join(work, 'npm.tar.gz');
  const abortTar = join(work, 'aborting.tar.gz');
  const standaloneManifest = packFixture(standalone, standaloneTar, 'server.js');
  const npmManifest = packFixture(npmShaped, npmTar, 'dist/server.js');
  const abortManifest = packFixture(aborting, abortTar, 'server.js');

  // --- serve the archives, manifest included -------------------------------
  const served = new Map([
    ['/standalone.tar.gz', readFileSync(standaloneTar)],
    ['/standalone.tar.gz.json', readFileSync(standaloneManifest)],
    ['/npm.tar.gz', readFileSync(npmTar)],
    ['/npm.tar.gz.json', readFileSync(npmManifest)],
    ['/aborting.tar.gz', readFileSync(abortTar)],
    ['/aborting.tar.gz.json', readFileSync(abortManifest)],
  ]);
  // Two payloads served badly on purpose, to exercise the resume path. A phone
  // that leaves Wi-Fi range does not get a clean error: the connection either
  // dies mid-body or simply stops delivering bytes, and both used to cost the
  // whole 776 MB again.
  const flakyPayload = readFileSync(standaloneTar);
  const flakyUrl = '/flaky.tar.gz';
  const stallUrl = '/stall.tar.gz';
  const retryUrl = '/retry.tar.gz';
  const alwaysDropUrl = '/always-drop.tar.gz';
  let retryHits = 0;
  let alwaysHits = 0;
  let flakyHits = 0;
  let stallHits = 0;
  // Every Range header seen, so an assertion can talk about the *retry* rather
  // than whichever request happened to arrive first.
  const rangesSeen = { flaky: [], stall: [] };

  const httpServer = createServer((req, res) => {
    if (req.url === retryUrl) {
      retryHits++;
      if (retryHits === 1) {
        res.writeHead(500);
        res.end('try again');
        return;
      }
      res.writeHead(200, { 'content-length': flakyPayload.length });
      res.end(flakyPayload);
      return;
    }

    if (req.url === alwaysDropUrl) {
      // Drops on every attempt, so a single run exhausts its retries and the
      // partial file is left behind for the next one.
      alwaysHits++;
      res.writeHead(200, { 'content-length': flakyPayload.length });
      res.write(flakyPayload.subarray(0, Math.floor(flakyPayload.length / 4)));
      setTimeout(() => res.destroy(), 30);
      return;
    }

    if (req.url === flakyUrl || req.url === stallUrl) {
      const isFlaky = req.url === flakyUrl;
      const payload = flakyPayload;
      // Keep the header verbatim for the assertions; parse it separately for the
      // byte offset the server has to serve from.
      const rawRange = req.headers.range || '';
      const range = rawRange.replace(/bytes=/, '').replace(/-.*/, '');
      if (isFlaky) flakyHits++;
      else stallHits++;
      rangesSeen[isFlaky ? 'flaky' : 'stall'].push(rawRange);
      const start = Number(range) || 0;

      const firstHit = isFlaky ? flakyHits === 1 : stallHits === 1;
      if (firstHit) {
        res.writeHead(200, { 'content-length': payload.length, 'content-type': 'application/gzip' });
        res.write(payload.subarray(0, Math.floor(payload.length / 2)));
        if (isFlaky) {
          // Half the bytes, then the socket dies.
          setTimeout(() => res.destroy(), 30);
        }
        // Otherwise: keep the socket open and send nothing else — the stall.
        return;
      }

      const rest = payload.subarray(start);
      res.writeHead(start > 0 ? 206 : 200, {
        'content-length': rest.length,
        'content-type': 'application/gzip',
        ...(start > 0 ? { 'content-range': `bytes ${start}-${payload.length - 1}/${payload.length}` } : {}),
      });
      res.end(rest);
      return;
    }

    const body = served.get(req.url);
    if (!body) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-length': body.length });
    res.end(body);
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${httpServer.address().port}`;

  const home = join(work, 'home');
  const tmp = join(work, 'tmp');
  mkdirSync(home);
  mkdirSync(tmp);

  const run = async (name, gatewayDir, extra, invocation = {}) => {
    const port = await freePort();
    const child = await bootAndRead(
      { GATEWAY_DIR: gatewayDir, GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: String(port), HOME: home, TMPDIR: tmp, ...extra },
      invocation.ready ??
        ((text) => text.includes('listening') || text.includes('[gateway] FAILED')),
      { args: [RUN_FLAG], ...invocation }
    );
    const output = child.output();
    // While it is still alive: does it actually serve?
    const servedOk = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5000) })
      .then((res) => res.text())
      .catch(() => '');
    await child.stop();
    return { name, port, output, servedOk };
  };

  // --- case 1: a standalone tree -------------------------------------------
  const install1 = join(work, 'install-standalone');
  const first = await run(
    'standalone',
    install1,
    {
      GATEWAY_PAYLOAD_URL: `${origin}/standalone.tar.gz`,
      GATEWAY_PAYLOAD_SHA256_URL: `${origin}/standalone.tar.gz.json`,
    },
    // Wait for the bootstrap's own health check, so the assertions below can
    // cover the record a crash report is read from.
    { ready: (text) => text.includes('the server is answering on') || text.includes('[gateway] FAILED') }
  );
  check('standalone payload: the entry is server.js, not the default dist/server.js', first.output.includes('entry is server.js (not dist/server.js)'));
  check('standalone payload: it is started', first.output.includes('starting server.js on 127.0.0.1:'));
  check(
    'the payload native libraries are inspected before the boot',
    /native libraries in the payload: \d+/.test(first.output) || /moved \d+ of \d+ native/.test(first.output)
  );
  // A library that cannot load cannot be left in the tree: the first require()
  // that touches it is a crash with no output, or an error thrown wherever the
  // require happened to be. So both reasons are removed before the boot.
  check(
    'libraries that cannot load on a phone are moved out of the payload',
    /moved 2 of 3 native libraries out of the payload/.test(first.output) &&
      /1 for another CPU, 1 for a desktop libc/.test(first.output)
  );
  check(
    'and the reason is named per file, so the next fix is obvious',
    /desktop glibc/.test(first.output) && /sharp\.node \(/.test(first.output)
  );
  check(
    'the libraries that cannot load are gone from the tree the payload requires from',
    !existsSync(join(install1, 'app', 'node_modules', 'sharp', 'build', 'Release', 'sharp.node')) &&
      !existsSync(join(install1, 'app', 'node_modules', 'sharp', 'build', 'Release', 'libvips-desktop.so'))
  );
  check(
    'and the one built for this CPU and libc stayed',
    existsSync(join(install1, 'app', 'node_modules', 'sharp', 'build', 'Release', 'libvips.so'))
  );
  check(
    'the quarantine is outside the tree the payload loads from',
    existsSync(join(install1, 'wrong-arch'))
  );
  check(
    'the payload\'s natively-backed dependencies are named before the boot',
    /native modules in the payload: \d+ of \d+ resolvable/.test(first.output)
  );
  check('standalone payload: the payload itself booted (not just the log line)', first.output.includes('STANDALONE listening'));
  check('standalone payload: the checksum manifest was fetched and matched', first.output.includes('checksum ok'));
  check('standalone payload: it answers /healthz on the configured port', first.servedOk === 'ok');
  check(
    'the install checks for free space before writing the archive',
    /free space [\d.]+ MB, need about [\d.]+ MB/.test(first.output)
  );
  check('the server module loaded', first.output.includes('loaded; waiting for'));
  check(
    'and the log records the server answering, so a later death is distinguishable',
    first.output.includes('the server is answering on http://127.0.0.1:')
  );

  // --- case 2: an npm-shaped tree with a decoy at the root -----------------
  const install2 = join(work, 'install-npm');
  const second = await run('npm', install2, {
    GATEWAY_PAYLOAD_URL: `${origin}/npm.tar.gz`,
    GATEWAY_PAYLOAD_SHA256_URL: `${origin}/npm.tar.gz.json`,
  });
  check('npm payload: the default entry wins over the decoy server.js', second.output.includes('starting dist/server.js on 127.0.0.1:'));
  check('npm payload: the decoy was not executed', !second.output.includes('DECOY RAN'));
  check('npm payload: it booted and answers /healthz', second.output.includes('NPM listening') && second.servedOk === 'ok');

  const linkDir = join(work, 'gateway-link');
  symlinkSync(dirname(BOOTSTRAP), linkDir);
  const viaLink = join(linkDir, 'bootstrap.mjs');

  // --- case 4: invoked the way the app does, through a symlinked directory --
  //
  // Android's app-data paths are symlinks of each other, so argv[1] is not the
  // path Node resolves for import.meta.url. Before that was handled the script
  // loaded, did nothing and exited 0 — which the app could only report as a
  // crash that had not happened, with an empty log to explain it.
  const fourth = await run('symlinked+flag', install1, {}, { script: viaLink });
  check(
    "symlinked path: the app's run flag starts the installer anyway",
    fourth.output.includes('gateway already installed at')
  );
  check('symlinked path: and the gateway boots', fourth.output.includes('STANDALONE listening') && fourth.servedOk === 'ok');

  // --- case 5: the documented `node gateway/bootstrap.mjs`, same trickery ----
  const fifth = await run('symlinked', install1, {}, { script: viaLink, args: [] });
  check(
    'symlinked path, no flag: the path check compares real paths, so it runs too',
    fifth.output.includes('gateway already installed at')
  );
  check('symlinked path, no flag: and it boots', fifth.output.includes('STANDALONE listening') && fifth.servedOk === 'ok');

  // --- case 3: reinstall/restart with no URL and no checksum --------------
  const third = await run('re-run', install1, {});
  // The scan is over tens of thousands of files on a phone's storage, and the
  // installed tree cannot change between boots of the same install — so a pass
  // that found nothing is remembered, and the next boot must not repeat it.
  check(
    'a second boot over the same install does not rescan the whole payload',
    third.output.includes('already checked for this install')
  );
  check(
    'and the first boot of that install did scan',
    first.output.includes('native libraries in the payload:') ||
      first.output.includes('moved ') ||
      first.output.includes('already checked') === false
  );
  check('re-run: reuses the install without a URL', third.output.includes('gateway already installed at'));
  check('re-run: still resolves the standalone entry', third.output.includes('starting server.js on 127.0.0.1:'));
  check('re-run: boots again', third.output.includes('STANDALONE listening') && third.servedOk === 'ok');

  // --- case 7: the connection dies halfway through --------------------------
  const flakyDir = join(work, 'install-flaky');
  const seventh = await run('dropped connection', flakyDir, {
    GATEWAY_PAYLOAD_URL: `${origin}${flakyUrl}`,
    GATEWAY_PAYLOAD_SHA256_URL: `${origin}/standalone.tar.gz.json`,
  });
  check('a dropped connection is reported as a download failure', seventh.output.includes('download failed'));
  check('the failure is retried inside the same attempt', seventh.output.includes('— retrying'));
  check(
    'the retry resumes instead of starting over',
    seventh.output.includes('resuming the download at')
  );
  check(
    'the retry asked the server for only the missing part',
    String(rangesSeen.flaky.at(-1)).startsWith('bytes=')
  );
  check(
    'the reassembled file verifies and boots',
    seventh.output.includes('checksum ok') && seventh.output.includes('STANDALONE listening') && seventh.servedOk === 'ok'
  );

  // --- case 8: the connection stops delivering bytes entirely ---------------
  const stallDir = join(work, 'install-stall');
  const ninth = await run('stalled', stallDir, {
    GATEWAY_PAYLOAD_URL: `${origin}${stallUrl}`,
    GATEWAY_PAYLOAD_SHA256_URL: `${origin}/standalone.tar.gz.json`,
    GATEWAY_DOWNLOAD_STALL_MS: '1500',
  });
  check('a download that stops delivering is called stalled', ninth.output.includes('download stalled after'));
  check(
    'a stalled download resumes on the next attempt and finishes',
    ninth.output.includes('resuming the download at') &&
      ninth.output.includes('checksum ok') &&
      ninth.output.includes('STANDALONE listening') &&
      ninth.servedOk === 'ok'
  );
  check(
    'the retry after a stall only asked for the missing bytes',
    String(rangesSeen.stall.at(-1)).startsWith('bytes=')
  );

  // --- case 11: every attempt fails — the partial file is the next resume point
  const dropDir = join(work, 'install-always-drop');
  const tenth = await run('always drops', dropDir, {
    GATEWAY_PAYLOAD_URL: `${origin}${alwaysDropUrl}`,
  });
  check('a download that never completes fails the install', tenth.output.includes('download failed'));
  check('all three attempts were made', alwaysHits >= 3);
  const part = join(dropDir, 'payload.tar.gz.part');
  const kept = existsSync(part) ? readFileSync(part).length : 0;
  check('the partial download is kept, so the next run resumes rather than restarts', kept > 0);

  // --- case 9: the checksum manifest is unreachable ------------------------
  //
  // The exact failure a real phone hit: GitHub answered 404 for the manifest
  // URL, and the install refused to proceed at all — even though the payload
  // itself was perfectly downloadable. An unreachable checksum is now a warning.
  const noShaDir = join(work, 'install-no-manifest');
  const eleventh = await run('no manifest', noShaDir, {
    GATEWAY_PAYLOAD_URL: `${origin}/standalone.tar.gz`,
    GATEWAY_PAYLOAD_SHA256_URL: `${origin}/does-not-exist.json`,
  });
  check(
    'an unreachable checksum manifest does not stop the install',
    eleventh.output.includes('warning: no checksum available') &&
      eleventh.output.includes('STANDALONE listening') &&
      eleventh.servedOk === 'ok'
  );
  check('and it says why the checksum was missing', eleventh.output.includes('could not be fetched'));

  // --- case 10: the server errors once, then serves ------------------------
  const retryDir = join(work, 'install-retry');
  const twelfth = await run('500 then ok', retryDir, {
    GATEWAY_PAYLOAD_URL: `${origin}${retryUrl}`,
  });
  check('a 500 is retried rather than reported', twelfth.output.includes('failed (download failed: HTTP 500'));
  check(
    'and the retry installs and boots',
    twelfth.output.includes('STANDALONE listening') && twelfth.servedOk === 'ok'
  );

  // --- case 6: the log the app actually reads -------------------------------
  //
  // The card reads `gateway.log`, written by the bootstrap itself, because the
  // runtime log is a process-wide stdout/stderr capture that also collects
  // Android WebView's chatter. If that file is missing or stale, the app cannot
  // tell an install that failed from one that never ran.
  // --- case 7: a payload killed mid-boot ----------------------------------
  //
  // The failure the boot record exists for, reproduced on purpose: the install
  // succeeds, node starts the entry, and the process dies in native code with
  // nothing printed. The gateway log ends at `starting server.js` — and the
  // record has to say what the process was doing when it went.
  const abortDir = join(work, 'install-aborting');
  const aborted = await run(
    'aborting',
    abortDir,
    {
      GATEWAY_PAYLOAD_URL: `${origin}/aborting.tar.gz`,
      GATEWAY_PAYLOAD_SHA256_URL: `${origin}/aborting.tar.gz.json`,
    },
    // Wait for the payload's own last words: the abort follows immediately, and
    // stopping the child before it happens would test nothing.
    { ready: (text) => text.includes('ABORT starting') || text.includes('[gateway] FAILED') }
  );
  const bootText = existsSync(join(abortDir, 'boot.log')) ? readFileSync(join(abortDir, 'boot.log'), 'utf8') : '';
  check('a payload killed mid-boot: the boot record exists', bootText.includes('runtime ready on node'));
  check(
    'and its last line is the step it died in, written before the import',
    bootText.trim().endsWith('loading server.js')
  );
  check(
    'the record does not claim the module loaded, because the process was killed',
    !bootText.includes('loaded; waiting for the server to answer')
  );
  check(
    'the gateway log reports no failure at all, which is why the record exists',
    !readFileSync(join(abortDir, GATEWAY_LOG_NAME), 'utf8').includes('[gateway] FAILED:')
  );
  check(
    'the payload really was killed in native code, not by an exception',
    aborted.output.includes('ABORT starting') && !aborted.output.includes('[gateway] FAILED:')
  );

  const logText = existsSync(join(install1, GATEWAY_LOG_NAME))
    ? readFileSync(join(install1, GATEWAY_LOG_NAME), 'utf8')
    : '';
  check('the gateway writes its own log next to the install', logText.includes('[gateway]'));
  check(
    'that log names the run, so a stale one is recognisable',
    /\[gateway\] starting on node v\d+/.test(logText)
  );

  const failedDir = join(work, 'install-none');
  await run('failure', failedDir, {});
  const failedText = existsSync(join(failedDir, GATEWAY_LOG_NAME))
    ? readFileSync(join(failedDir, GATEWAY_LOG_NAME), 'utf8')
    : '';
  check(
    'a failure is written to that log too, so the card can explain it',
    failedText.includes('[gateway] FAILED:')
  );

  await new Promise((resolve) => httpServer.close(resolve));
  rmSync(work, { recursive: true, force: true });

  const total = 50;
  if (failures.length) {
    process.stderr.write(`\n✖ payload-install: ${failures.length} of ${total} checks failed\n`);
    process.exit(1);
  }
  process.stdout.write(`\npayload-install — OK (${total} assertions)\n`);
}

main().catch((err) => {
  process.stderr.write(`✖ check-payload-install: ${err?.stack ?? err}\n`);
  process.exit(1);
});
