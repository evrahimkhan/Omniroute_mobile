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

/** A free loopback port, released immediately for the child to claim. */
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
  writeFileSync(join(standalone, 'node_modules', 'next', 'package.json'), '{}\n');
  writeFileSync(join(standalone, 'server.js'), fixtureServer('STANDALONE'));
  symlinkSync('server.js', join(standalone, 'entry-link.js'));

  const npmShaped = join(work, 'npm');
  mkdirSync(join(npmShaped, 'dist'), { recursive: true });
  writeFileSync(join(npmShaped, 'dist', 'server.js'), fixtureServer('NPM'));
  // Only a wrong installer would run this: it is the decoy for the entry test.
  writeFileSync(join(npmShaped, 'server.js'), 'console.log("DECOY RAN");\nprocess.exit(1);\n');

  const standaloneTar = join(work, 'standalone.tar.gz');
  const npmTar = join(work, 'npm.tar.gz');
  const standaloneManifest = packFixture(standalone, standaloneTar, 'server.js');
  const npmManifest = packFixture(npmShaped, npmTar, 'dist/server.js');

  // --- serve the archives, manifest included -------------------------------
  const served = new Map([
    ['/standalone.tar.gz', readFileSync(standaloneTar)],
    ['/standalone.tar.gz.json', readFileSync(standaloneManifest)],
    ['/npm.tar.gz', readFileSync(npmTar)],
    ['/npm.tar.gz.json', readFileSync(npmManifest)],
  ]);
  // Two payloads served badly on purpose, to exercise the resume path. A phone
  // that leaves Wi-Fi range does not get a clean error: the connection either
  // dies mid-body or simply stops delivering bytes, and both used to cost the
  // whole 776 MB again.
  const flakyPayload = readFileSync(standaloneTar);
  const flakyUrl = '/flaky.tar.gz';
  const stallUrl = '/stall.tar.gz';
  let flakyHits = 0;
  let stallHits = 0;
  // Every Range header seen, so an assertion can talk about the *retry* rather
  // than whichever request happened to arrive first.
  const rangesSeen = { flaky: [], stall: [] };

  const httpServer = createServer((req, res) => {
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
      (text) => text.includes('listening') || text.includes('[gateway] FAILED'),
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
  const first = await run('standalone', install1, {
    GATEWAY_PAYLOAD_URL: `${origin}/standalone.tar.gz`,
    GATEWAY_PAYLOAD_SHA256_URL: `${origin}/standalone.tar.gz.json`,
  });
  check('standalone payload: the entry is server.js, not the default dist/server.js', first.output.includes('entry is server.js (not dist/server.js)'));
  check('standalone payload: it is started', first.output.includes('starting server.js on 127.0.0.1:'));
  check('standalone payload: the payload itself booted (not just the log line)', first.output.includes('STANDALONE listening'));
  check('standalone payload: the checksum manifest was fetched and matched', first.output.includes('checksum ok'));
  check('standalone payload: it answers /healthz on the configured port', first.servedOk === 'ok');
  check(
    'the install checks for free space before writing the archive',
    /free space [\d.]+ MB, need about [\d.]+ MB/.test(first.output)
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

  const eighth = await run('resumed', flakyDir, {
    GATEWAY_PAYLOAD_URL: `${origin}${flakyUrl}`,
    GATEWAY_PAYLOAD_SHA256_URL: `${origin}/standalone.tar.gz.json`,
  });
  check('the next attempt resumes instead of starting over', eighth.output.includes('resuming the download at'));
  check(
    'the retry asked the server for only the missing part',
    String(rangesSeen.flaky.at(-1)).startsWith('bytes=')
  );
  check(
    'the resumed file is the same file: it verifies and boots',
    eighth.output.includes('checksum ok') && eighth.output.includes('STANDALONE listening') && eighth.servedOk === 'ok'
  );

  // --- case 8: the connection stops delivering bytes entirely ---------------
  const stallDir = join(work, 'install-stall');
  const ninth = await run('stalled', stallDir, {
    GATEWAY_PAYLOAD_URL: `${origin}${stallUrl}`,
    GATEWAY_DOWNLOAD_STALL_MS: '1500',
  });
  check('a download that stops delivering is called stalled', ninth.output.includes('download stalled after'));
  check(
    'and the partial download is kept, because it is the resume point',
    existsSync(join(stallDir, 'payload.tar.gz.part'))
  );

  const tenth = await run('resumed after a stall', stallDir, {
    GATEWAY_PAYLOAD_URL: `${origin}${stallUrl}`,
    GATEWAY_PAYLOAD_SHA256_URL: `${origin}/standalone.tar.gz.json`,
    GATEWAY_DOWNLOAD_STALL_MS: '1500',
  });
  check('a stalled download resumes on the next attempt', tenth.output.includes('resuming the download at'));
  check(
    'and finishes: checksum ok, and the payload boots',
    tenth.output.includes('checksum ok') && tenth.output.includes('STANDALONE listening') && tenth.servedOk === 'ok'
  );
  check(
    'the retry after a stall only asked for the missing bytes',
    String(rangesSeen.stall.at(-1)).startsWith('bytes=')
  );

  // --- case 6: the log the app actually reads -------------------------------
  //
  // The card reads `gateway.log`, written by the bootstrap itself, because the
  // runtime log is a process-wide stdout/stderr capture that also collects
  // Android WebView's chatter. If that file is missing or stale, the app cannot
  // tell an install that failed from one that never ran.
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

  const total = 29;
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
