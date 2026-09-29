#!/usr/bin/env node
/**
 * Embeds gateway/bootstrap.mjs into the app bundle.
 *
 * The bootstrap has to reach the device as part of the APK — it is the thing
 * that downloads everything else, so it cannot itself be downloaded. The app's
 * only way to ship a string of code is inside the JavaScript bundle, so this
 * script turns the real, runnable script into a generated TypeScript constant.
 *
 * Keeping `gateway/bootstrap.mjs` as the source of truth means the installer can
 * be run and tested directly by Node (see the repo's test notes), instead of
 * living as an untestable string literal.
 *
 *   node scripts/embed-gateway-bootstrap.mjs           # regenerate
 *   node scripts/embed-gateway-bootstrap.mjs --check   # fail if stale (CI)
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'gateway', 'bootstrap.mjs');
const TARGET = join(ROOT, 'lib', 'gateway', 'bootstrapScript.generated.ts');

const HEADER = `// GENERATED FILE — do not edit by hand.
//
// Source: gateway/bootstrap.mjs
// Regenerate: npm run gateway:embed
//
// The bootstrap script runs inside the embedded Node runtime on the device. It
// is embedded here because the app has no other way to ship it: the script is
// what downloads the gateway payload, so it cannot be part of that payload.
`;

function generate() {
  const source = readFileSync(SOURCE, 'utf8');
  if (!source.includes('export { extractTarGz')) {
    throw new Error(
      `${relative(ROOT, SOURCE)} does not look like the bootstrap script (expected its exports block)`
    );
  }
  // JSON.stringify gives correct escaping for every character, including the
  // backticks and ${} that would break a template literal.
  return `${HEADER}\nexport const BOOTSTRAP_SCRIPT = ${JSON.stringify(source)};\n`;
}

const check = process.argv.includes('--check');
const next = generate();
let current = null;
try {
  current = readFileSync(TARGET, 'utf8');
} catch {
  current = null;
}

if (check) {
  if (current === next) {
    process.stdout.write('gateway:embed — bootstrap script is up to date\n');
    process.exit(0);
  }
  process.stderr.write(
    '✖ lib/gateway/bootstrapScript.generated.ts is out of date with gateway/bootstrap.mjs\n' +
      '  Run: npm run gateway:embed\n'
  );
  process.exit(1);
}

if (current === next) {
  process.stdout.write('gateway:embed — already up to date\n');
} else {
  mkdirSync(dirname(TARGET), { recursive: true });
  writeFileSync(TARGET, next);
  process.stdout.write(
    `gateway:embed — wrote ${relative(ROOT, TARGET)} (${next.length} bytes)\n`
  );
}
