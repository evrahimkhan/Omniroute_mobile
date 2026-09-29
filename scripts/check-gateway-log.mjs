#!/usr/bin/env node
/**
 * Checks the log parser against the lines the bootstrap actually prints.
 *
 * Why this exists: `lib/gatewayLog.ts` turns the embedded runtime's log into
 * progress and phases, and it only works if its patterns match
 * `gateway/bootstrap.mjs` exactly. When they drifted — the parser looked for
 * `already installed`, the script printed `gateway already installed` — nothing
 * failed, the phase simply never fired, and the UI quietly showed the wrong
 * thing. It then drifted a second time (the parser looked for
 * `warning: GATEWAY_PAYLOAD_SHA256 is not set`, the script printed
 * `warning: no checksum available (…)`), which the probes below could not see
 * because a stale sample line still parses perfectly.
 *
 * So each case carries an `anchor`: the run of characters the line's meaning
 * depends on, which must appear both in the bootstrap source and in the sample
 * line. A reworded message now fails here, naming the anchor that disappeared.
 *
 * `lib/gatewayLog.ts` is deliberately pure (no native imports), which is what
 * makes it runnable like this: compile it, then assert on the output.
 *
 *   node scripts/check-gateway-log.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'lib', 'gatewayLog.ts');
const BOOTSTRAP = join(ROOT, 'gateway', 'bootstrap.mjs');

/**
 * [log line, expected kind, expected detail (null = must be absent), anchor]
 *
 * The log line is a real-world sample (numbers, paths and timestamps vary);
 * the anchor is the part of that message the parser keys on, copied verbatim
 * from the bootstrap.
 */
const CASES = [
  ['[gateway] downloading http://example/omniroute.tar.gz', 'downloading', null, 'downloading '],
  ['[gateway] payload is 115.7 MB', 'downloading', 'payload is 115.7 MB', 'payload is '],
  ['[gateway] downloaded 48.1 MB (42%)', 'downloading', '48.1 MB (42%)', 'downloaded '],
  ['[gateway] downloaded 115.7 MB', 'downloading', '115.7 MB', 'downloaded '],
  ['[gateway] resuming the download at 512.0 MB', 'downloading', '512.0 MB', 'resuming the download at'],
  [
    '[gateway] reusing the previously downloaded payload',
    'reusing',
    null,
    'reusing the previously downloaded payload',
  ],
  ['[gateway] verifying checksum…', 'verifying', null, 'verifying checksum'],
  ['[gateway] checksum ok', 'verifying', null, 'checksum ok'],
  [
    '[gateway] warning: no checksum available (GATEWAY_PAYLOAD_SHA256 and GATEWAY_PAYLOAD_SHA256_URL are both unset) — installing without integrity verification',
    'verifying',
    null,
    'warning: no checksum available',
  ],
  ['[gateway] extracting… 12940 files, 392.0 MB', 'extracting', '12940 files, 392.0 MB', 'extracting… '],
  ['[gateway] extracted 21898 files, 431.6 MB, 0 dirs', 'extracting', '21898 files, 431.6 MB, 0 dirs', 'extracted '],
  ['[gateway] install complete', 'installed', null, 'install complete'],
  // The exact shape of the line that drifted the first time.
  [
    '[gateway] gateway already installed at /data/user/0/app/files/node-runtime/app (2026-09-29T09:01:01.829Z)',
    'starting',
    null,
    'gateway already installed at ',
  ],
  ['[gateway] starting dist/server.js on 127.0.0.1:20128', 'starting', 'dist/server.js on 127.0.0.1:20128', 'starting '],
  [
    '[gateway] FAILED: Error: checksum mismatch: expected abc, got def',
    'failed',
    'Error: checksum mismatch: expected abc, got def',
    'checksum mismatch: expected ',
  ],
];

function compile() {
  const out = mkdtempSync(join(tmpdir(), 'gateway-log-'));
  execFileSync(
    'npx',
    [
      'tsc',
      SOURCE,
      '--ignoreConfig',
      '--outDir',
      out,
      '--module',
      'esnext',
      '--target',
      'es2022',
      '--skipLibCheck',
    ],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] }
  );
  return { out, file: join(out, 'gatewayLog.js') };
}

async function main() {
  const { out, file } = compile();
  try {
    const {
      gatewayProgress,
      gatewayLogTail,
      describeGatewayLog,
      gatewayNeverRan,
      describeRuntimeExit,
      deriveGatewayPhase,
      describeBootTrace,
      bootRecordStep,
    } = await import(pathToFileURL(file).href);

    const failures = [];
    // Counted, not calculated: the summary used to multiply the sample table by
    // two and add a constant, so checks added anywhere else were reported
    // without being counted — a number that says nothing about what ran.
    let checks = 0;
    const check = (label, ok) => {
      checks += 1;
      if (!ok) failures.push(label);
    };

    // Every sample line must still rest on text the bootstrap really prints.
    const bootstrap = readFileSync(BOOTSTRAP, 'utf8');
    for (const [line, , , anchor] of CASES) {
      checks += 1;
      if (!anchor) {
        failures.push(`${line} → case has no anchor`);
      } else if (!line.includes(anchor)) {
        failures.push(`${line} → the sample line no longer contains its anchor ${JSON.stringify(anchor)}`);
      } else if (!bootstrap.includes(anchor)) {
        failures.push(
          `${line} → anchor ${JSON.stringify(anchor)} is gone from gateway/bootstrap.mjs (rewording?)`
        );
      }
    }

    for (const [line, kind, detail] of CASES) {
      checks += 2;
      const got = gatewayProgress(line);
      if (!got) {
        failures.push(`${line} → nothing (expected kind "${kind}")`);
        continue;
      }
      if (got.kind !== kind) {
        failures.push(`${line} → kind "${got.kind}" (expected "${kind}")`);
      }
      if (detail === null && got.detail !== undefined) {
        failures.push(`${line} → unexpected detail "${got.detail}"`);
      }
      if (detail !== null && got.detail !== detail) {
        failures.push(`${line} → detail "${got.detail}" (expected "${detail}")`);
      }
    }

    // The most recent recognised line wins, even with unrecognised lines after it.
    const interleaved = [
      '[gateway] downloaded 8.1 MB (7%)',
      '[gateway] payload is nested under package/',
      '[gateway] extracting… 589 files, 8.4 MB',
    ].join('\n');
    check(
      'latest recognised line wins',
      gatewayProgress(interleaved)?.kind === 'extracting'
    );

    // Percentages become fractions; no percentage means no fraction.
    const withPercent = gatewayProgress('[gateway] downloaded 48.1 MB (42%)');
    if (withPercent?.fraction !== 0.42) failures.push(`fraction: got ${withPercent?.fraction}, expected 0.42`);
    const noPercent = gatewayProgress('[gateway] downloaded 48.1 MB');
    if (noPercent && 'fraction' in noPercent && noPercent.fraction !== undefined) {
      failures.push(`fraction should be absent without a percentage, got ${noPercent.fraction}`);
    }

    // Lines we do not know are not guessed at.
    check(
      'unknown log gives null',
      gatewayProgress('▲ Next.js 16.3.1\n- Local: http://127.0.0.1:20128\n✓ Ready in 0ms') === null
    );

    // Phase mapping, including the case that used to silently fail.
    check('failed phase', describeGatewayLog('[gateway] FAILED: boom').phase === 'failed');
    check(
      'failure message is surfaced',
      describeGatewayLog('[gateway] FAILED: boom').error === 'boom'
    );
    check('install complete → starting', describeGatewayLog('[gateway] install complete').phase === 'starting');
    check(
      'already installed → starting',
      describeGatewayLog('[gateway] gateway already installed at /x (t)').phase === 'starting'
    );
    check(
      'mid-download → installing',
      describeGatewayLog('[gateway] downloaded 8.1 MB (7%)').phase === 'installing'
    );
    check('empty log → null', describeGatewayLog('').phase === null);

    // --- the boot record -----------------------------------------------------
    //
    // Every marker here is written by `openBootLog`/`bootTrace` in the bootstrap
    // and matched by `describeBootTrace`, so the two are checked against each
    // other: the anchor must be in the script, and the sentence must name the
    // step. That pairing is the point — the record is only worth writing if the
    // app reads the same words, and a reworded marker fails here by name.
    const BOOT_CASES = [
      [
        '01 runtime ready on node v24.20.0 (pid 1234)',
        'before anything else',
        'runtime ready on node ',
      ],
      ['02 installing the payload', 'during the install', 'installing the payload'],
      ['03 the payload is installed', 'after installing the payload', 'the payload is installed'],
      ['04 loading dist/server.js', 'died while loading dist/server.js', 'loading ${entry}'],
      [
        '05 dist/server.js loaded; waiting for the server to answer',
        'died before it answered',
        'loaded; waiting for the server to answer',
      ],
      ['06 the server is answering', 'The server answered', 'the server is answering'],
      ['07 the server never answered', 'never answered on its port', 'the server never answered'],
      ['08 the process is exiting (code 1)', 'ended itself (exit code 1)', 'the process is exiting (code '],
      ['09 the process is exiting (code 0)', 'ended normally', 'the process is exiting (code '],
      ['10 asked to stop (SIGTERM)', 'asked to stop (SIGTERM)', 'asked to stop (${signal})'],
      ['11 uncaught exception: Error: boom', 'crashed on its own: Error: boom', 'uncaught exception: '],
      ['12 unhandled rejection: Error: nope', 'crashed on its own: Error: nope', 'unhandled rejection: '],
    ];
    for (const [line, expected, anchor] of BOOT_CASES) {
      checks += 2;
      const said = describeBootTrace(line);
      if (!said) {
        failures.push(`boot record: ${line} → nothing`);
        continue;
      }
      if (!said.includes(expected)) {
        failures.push(`boot record: ${line} → ${JSON.stringify(said)} does not mention ${expected}`);
      }
      if (!bootstrap.includes(anchor)) {
        failures.push(
          `boot record: ${line} → anchor ${JSON.stringify(anchor)} is gone from gateway/bootstrap.mjs`
        );
      }
    }

    // The record's whole reason for existing: the *last* line is the answer, and
    // the earlier ones must not be mistaken for it.
    check(
      'the last recorded step is the one reported',
      (describeBootTrace('04 loading dist/server.js\n05 dist/server.js loaded; waiting for the server to answer') ?? '')
        .includes('died before it answered')
    );
    check(
      'an empty record says nothing at all',
      describeBootTrace('') === null && describeBootTrace('   \n') === null
    );

    // The step without the conclusion: this is what a boot in progress shows, so
    // it must be the file's own words with only the sequence number removed.
    check(
      'the recorded step is reported verbatim',
      bootRecordStep('01 runtime ready on node v24.20.0 (pid 9)\n02 loading dist/server.js') ===
        'loading dist/server.js'
    );
    check('no record means no step', bootRecordStep('') === null && bootRecordStep('\n ') === null);
    check(
      'a step that happens to start with digits keeps them',
      bootRecordStep('07 404.html could not be read') === '404.html could not be read'
    );
    // Written ahead of the step: a killed process leaves the step it was in, not
    // the one it finished.
    check(
      'a record that stops at the load names the load',
      (describeBootTrace('01 runtime ready on node v24.20.0 (pid 1)\n02 loading dist/server.js') ?? '')
        .includes('while loading dist/server.js')
    );

    check(
      'an empty log means the gateway script never ran',
      gatewayNeverRan('') && gatewayNeverRan('[node-runtime] node exited with code 0')
    );
    check(
      'a log with a gateway line means it did run',
      !gatewayNeverRan('[gateway] installing…') && !gatewayNeverRan('[node-runtime] x\n[gateway] starting a')
    );
    check(
      'an exit with no output is worded as "never ran", not as a crash',
      describeRuntimeExit(0, '').includes('never ran') && describeRuntimeExit(null, '').includes('code unknown')
    );
    check(
      'a missing payload says where the payload comes from',
      (describeGatewayLog('[gateway] FAILED: Error: download failed: HTTP 404 Not Found').error ?? '')
        .includes('Build OmniRoute web gateway')
    );
    check(
      'other failures are reported verbatim',
      describeGatewayLog('[gateway] FAILED: Error: checksum mismatch: expected a, got b').error ===
        'Error: checksum mismatch: expected a, got b'
    );
    check(
      'an exit after the script was handed over says the script printed nothing',
      describeRuntimeExit(0, '[node-runtime] starting node v24.20.0: /x/bootstrap.mjs').includes(
        'printed nothing'
      )
    );
    check(
      'a memory line alone is not proof the script was handed over',
      describeRuntimeExit(0, '[node-runtime] memory: heap limit 512 MB, used 30 MB').includes(
        'without starting the gateway script'
      )
    );
    check(
      'an exit with no runtime marker says the script was never started',
      describeRuntimeExit(0, '[0929/175611:INFO:android_webview] seed loader noise').includes(
        'without starting the gateway script'
      )
    );
    check(
      'an exit that printed something keeps it plain',
      describeRuntimeExit(1, '[gateway] FAILED: boom') === 'The embedded runtime exited (code 1).'
    );

    // The phase comes from the runtime's state, refined by the log — never from
    // the log alone. The stuck card came from the log winning.
    const STARTED = '[gateway] starting server.js on 127.0.0.1:20128';
    check(
      'a running runtime that is installing reads as installing',
      deriveGatewayPhase({ running: true, exited: false, hasMarker: false, log: '[gateway] downloaded 8.1 MB (7%)' }) ===
        'installing'
    );
    check(
      'a running runtime that has started the server reads as starting',
      deriveGatewayPhase({ running: true, exited: false, hasMarker: true, log: STARTED }) === 'starting'
    );
    check(
      'an exited runtime reads as failed',
      deriveGatewayPhase({ running: false, exited: true, hasMarker: true, log: STARTED }) === 'failed'
    );
    check(
      'a printed failure reads as failed even if nothing exited',
      deriveGatewayPhase({ running: false, exited: false, hasMarker: true, log: '[gateway] FAILED: boom' }) ===
        'failed'
    );
    // The regression: after a crash this line is the last thing written, and
    // reading it as "starting" left a fresh session spinning forever.
    check(
      'a stale "starting" line with nothing running reads as idle, not starting',
      deriveGatewayPhase({ running: false, exited: false, hasMarker: true, log: STARTED }) === 'idle'
    );
    check(
      'a stale "downloading" line with nothing running reads as idle too',
      deriveGatewayPhase({ running: false, exited: false, hasMarker: true, log: '[gateway] downloaded 8.1 MB (7%)' }) ===
        'idle'
    );

    check('tail keeps the end', gatewayLogTail('a\nb\nc\nd', 2) === 'c\nd');
    check('tail strips blanks', gatewayLogTail('a\n\n  \nb', 5) === 'a\nb');

    if (failures.length) {
      process.stderr.write(`\n✖ gateway log parser is out of sync (${failures.length}):\n`);
      for (const failure of failures) process.stderr.write(`  · ${failure}\n`);
      process.stderr.write(
        '\nIf gateway/bootstrap.mjs changed its log lines, update lib/gatewayLog.ts and the CASES above to match.\n'
      );
      process.exit(1);
    }
    process.stdout.write(
      `gateway:test — OK (${checks} assertions, ${CASES.length + BOOT_CASES.length} lines anchored to the bootstrap)\n`
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`✖ check-gateway-log: ${err?.message ?? err}\n`);
  process.exit(1);
});
