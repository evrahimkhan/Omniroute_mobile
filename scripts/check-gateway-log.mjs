#!/usr/bin/env node
/**
 * Checks the log parser against the lines the bootstrap actually prints.
 *
 * Why this exists: `lib/gatewayLog.ts` turns the embedded runtime's log into
 * progress and phases, and it only works if its patterns match
 * `gateway/bootstrap.mjs` exactly. When they drifted — the parser looked for
 * `already installed`, the script printed `gateway already installed` — nothing
 * failed, the phase simply never fired, and the UI quietly showed the wrong
 * thing. Every string below is copied from the bootstrap's own `log(...)` calls,
 * so a change there shows up here.
 *
 * `lib/gatewayLog.ts` is deliberately pure (no native imports), which is what
 * makes it runnable like this: compile it, then assert on the output.
 *
 *   node scripts/check-gateway-log.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'lib', 'gatewayLog.ts');

/** [log line, expected kind, expected detail (null = must be absent)] */
const CASES = [
  ['[gateway] downloading http://example/omniroute.tar.gz', 'downloading', null],
  ['[gateway] payload is 115.7 MB', 'downloading', 'payload is 115.7 MB'],
  ['[gateway] downloaded 48.1 MB (42%)', 'downloading', '48.1 MB (42%)'],
  ['[gateway] downloaded 115.7 MB', 'downloading', '115.7 MB'],
  ['[gateway] reusing the previously downloaded payload', 'reusing', null],
  ['[gateway] verifying checksum…', 'verifying', null],
  ['[gateway] checksum ok', 'verifying', null],
  [
    '[gateway] warning: GATEWAY_PAYLOAD_SHA256 is not set — installing without integrity verification',
    'verifying',
    null,
  ],
  ['[gateway] extracting… 12940 files, 392.0 MB', 'extracting', '12940 files, 392.0 MB'],
  ['[gateway] extracted 21898 files, 431.6 MB, 0 dirs', 'extracting', '21898 files, 431.6 MB, 0 dirs'],
  ['[gateway] install complete', 'installed', null],
  // The exact shape of line 330 in gateway/bootstrap.mjs — the one that drifted.
  [
    '[gateway] gateway already installed at /data/user/0/app/files/node-runtime/app (2026-09-29T09:01:01.829Z)',
    'starting',
    null,
  ],
  ['[gateway] starting dist/server.js on 127.0.0.1:20128', 'starting', 'dist/server.js on 127.0.0.1:20128'],
  ['[gateway] FAILED: Error: checksum mismatch: expected abc, got def', 'failed', 'Error: checksum mismatch: expected abc, got def'],
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
    const { gatewayProgress, gatewayLogTail, describeGatewayLog } = await import(pathToFileURL(file).href);

    const failures = [];
    const check = (label, ok) => {
      if (!ok) failures.push(label);
    };

    for (const [line, kind, detail] of CASES) {
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

    check('tail keeps the end', gatewayLogTail('a\nb\nc\nd', 2) === 'c\nd');
    check('tail strips blanks', gatewayLogTail('a\n\n  \nb', 5) === 'a\nb');

    if (failures.length) {
      process.stderr.write(`\n✖ gateway log parser is out of sync (${failures.length}):\n`);
      for (const failure of failures) process.stderr.write(`  · ${failure}\n`);
      process.stderr.write(
        '\nIf gateway/bootstrap.mjs changed its log lines, update lib/gatewayLog.ts to match.\n'
      );
      process.exit(1);
    }
    process.stdout.write(`gateway:test — OK (${CASES.length + 9} assertions)\n`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`✖ check-gateway-log: ${err?.message ?? err}\n`);
  process.exit(1);
});
