#!/usr/bin/env node
/**
 * Exercises the gateway-URL rules against the real module.
 *
 * Why this exists: typing `127.0.0.1:20128` into the app's gateway field used to
 * become `https://127.0.0.1:20128`, because the normalizer added `https://` to
 * anything without a scheme. Against a gateway that serves plain HTTP that is
 * not a cosmetic slip: `fetch` fails the TLS handshake and reports only
 * "Network error", the WebView reports only ERR_SSL_PROTOCOL_ERROR, and the
 * gateway — demonstrably running, logging requests — looks unreachable from the
 * only screen that can connect to it.
 *
 * The rule is behavioural now (the scheme follows the host), so this test
 * compiles `lib/serverUrl.ts` with the repo's own TypeScript and calls the real
 * functions rather than asserting on source text. `lib/gateway.ts` is compiled
 * alongside it so the composed URL — what the WebView actually loads — is
 * checked too.
 *
 *   node scripts/check-server-url.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let failures = 0;
let checks = 0;

function check(name, ok) {
  checks += 1;
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}`);
  }
}

/** Compile the modules under test with the repo's TypeScript. */
function compiled() {
  const out = mkdtempSync(join(tmpdir(), 'server-url-'));
  const tsc = join(root, 'node_modules', '.bin', 'tsc');
  const bin = existsSync(tsc) ? tsc : 'npx';
  const args = [
    'lib/serverUrl.ts',
    'lib/gateway.ts',
    '--outDir',
    out,
    '--module',
    'commonjs',
    '--target',
    'es2020',
    // moduleResolution is deliberately left at the default: naming it is a
    // deprecation error in the TypeScript this repo pins.
    '--skipLibCheck',
    '--strict',
    // TypeScript refuses to take files on the command line while a tsconfig.json
    // sits next to them unless it is told to ignore it. These two modules are
    // pure TypeScript with no ambient types, which is why compiling them here
    // (rather than the whole app) is enough.
    '--ignoreConfig',
  ];
  execFileSync(bin, existsSync(tsc) ? args : ['tsc', ...args], { cwd: root, stdio: 'inherit' });
  return { out, serverUrl: require(join(out, 'serverUrl.js')), gateway: require(join(out, 'gateway.js')) };
}

const { out, serverUrl, gateway } = compiled();
const { normalizeServerUrl, repairServerUrl, assumedScheme, isLoopbackAddress } = serverUrl;

try {
  // --- the case from the phone: a bare loopback address ----------------------
  check(
    '127.0.0.1:20128 (what was typed) becomes http, not https',
    normalizeServerUrl('127.0.0.1:20128') === 'http://127.0.0.1:20128'
  );
  check(
    'localhost:20128 becomes http',
    normalizeServerUrl('localhost:20128') === 'http://localhost:20128'
  );
  check(
    '[::1]:20128 becomes http',
    normalizeServerUrl('[::1]:20128') === 'http://[::1]:20128'
  );

  // --- the local network ----------------------------------------------------
  check(
    '192.168.1.10:20128 becomes http',
    normalizeServerUrl('192.168.1.10:20128') === 'http://192.168.1.10:20128'
  );
  check('10.0.0.5 becomes http', normalizeServerUrl('10.0.0.5') === 'http://10.0.0.5');
  check(
    '172.16.4.4:20128 becomes http',
    normalizeServerUrl('172.16.4.4:20128') === 'http://172.16.4.4:20128'
  );
  check(
    '172.32.4.4 is outside the private range and keeps https',
    normalizeServerUrl('172.32.4.4:20128') === 'https://172.32.4.4:20128'
  );
  check(
    'link-local 169.254.10.10:20128 becomes http',
    normalizeServerUrl('169.254.10.10:20128') === 'http://169.254.10.10:20128'
  );
  check(
    'gateway.local:20128 (mDNS) becomes http',
    normalizeServerUrl('gateway.local:20128') === 'http://gateway.local:20128'
  );
  check(
    'box.home.arpa:20128 becomes http',
    normalizeServerUrl('box.home.arpa:20128') === 'http://box.home.arpa:20128'
  );
  check(
    'a single-label hostname is this LAN: myserver:20128 becomes http',
    normalizeServerUrl('myserver:20128') === 'http://myserver:20128'
  );

  // --- public gateways keep https -------------------------------------------
  check(
    'omniroute.online keeps https',
    normalizeServerUrl('omniroute.online') === 'https://omniroute.online'
  );
  check(
    'a public host with a port keeps https',
    normalizeServerUrl('omniroute.online:8443') === 'https://omniroute.online:8443'
  );
  check(
    'a tunnel domain keeps https',
    normalizeServerUrl('abc-123.trycloudflare.com') === 'https://abc-123.trycloudflare.com'
  );

  // --- an explicit scheme is never second-guessed ----------------------------
  check(
    'an explicit http on a LAN address is kept',
    normalizeServerUrl('http://192.168.1.10:20128') === 'http://192.168.1.10:20128'
  );
  check(
    'an explicit https on a LAN address is kept (a proxy with a private CA)',
    normalizeServerUrl('https://192.168.1.10:20128') === 'https://192.168.1.10:20128'
  );
  check(
    'an explicit http on a public host is kept',
    normalizeServerUrl('http://omniroute.online') === 'http://omniroute.online'
  );

  // --- shapes that must not break the rule ----------------------------------
  check('an empty string stays empty', normalizeServerUrl('') === '');
  check('whitespace alone stays empty', normalizeServerUrl('   ') === '');
  check(
    'surrounding whitespace is trimmed',
    normalizeServerUrl('  127.0.0.1:20128  ') === 'http://127.0.0.1:20128'
  );
  check(
    'trailing slashes are dropped',
    normalizeServerUrl('http://127.0.0.1:20128///') === 'http://127.0.0.1:20128'
  );
  check(
    'a path does not change the scheme decision',
    normalizeServerUrl('192.168.1.10:20128/dashboard') === 'http://192.168.1.10:20128/dashboard'
  );
  check(
    'a query does not change the scheme decision',
    normalizeServerUrl('omniroute.online?x=1') === 'https://omniroute.online?x=1'
  );
  check(
    'credentials do not fool the host rule',
    normalizeServerUrl('user@127.0.0.1:20128') === 'http://user@127.0.0.1:20128'
  );
  check(
    'assumedScheme answers the same question directly',
    assumedScheme('127.0.0.1:20128') === 'http' && assumedScheme('omniroute.online') === 'https'
  );

  // --- the URL the WebView actually loads -----------------------------------
  check(
    'gatewayUrl composes over the local gateway',
    gateway.gatewayUrl('127.0.0.1:20128', '/healthz') === 'http://127.0.0.1:20128/healthz'
  );
  check(
    'gatewayUrl handles a path without a leading slash',
    gateway.gatewayUrl('192.168.1.10:20128', 'dashboard') === 'http://192.168.1.10:20128/dashboard'
  );
  check(
    'hostOf reports the host the app compares against',
    gateway.hostOf('127.0.0.1:20128') === '127.0.0.1:20128'
  );

  // --- repairing a URL that was already saved wrong -------------------------
  check(
    'a saved https to loopback is repaired to http',
    repairServerUrl('https://127.0.0.1:20128') === 'http://127.0.0.1:20128'
  );
  check(
    'a saved https to localhost is repaired',
    repairServerUrl('https://localhost:20128') === 'http://localhost:20128'
  );
  check(
    'a saved https to a LAN address is left alone',
    repairServerUrl('https://192.168.1.10:20128') === 'https://192.168.1.10:20128'
  );
  check(
    'a saved https to a public gateway is left alone',
    repairServerUrl('https://omniroute.online') === 'https://omniroute.online'
  );
  check(
    'repairing a bare address is just normalizing it',
    repairServerUrl('127.0.0.1:20128') === 'http://127.0.0.1:20128'
  );

  // --- one source of truth, and a failure that says what it tried -----------
  const gatewaySrc = readFileSync(join(root, 'lib', 'gateway.ts'), 'utf8');
  check(
    'the scheme rule lives in one place (gateway.ts imports it)',
    gatewaySrc.includes("import { normalizeServerUrl } from './serverUrl'") &&
      !/url = `https:\/\/\$\{url\}`/.test(gatewaySrc)
  );
  check(
    'a failed probe names the URL it tried',
    /no answer from \$\{base\}/.test(gatewaySrc)
  );

  const settingsSrc = readFileSync(join(root, 'lib', 'useSettings.ts'), 'utf8');
  check(
    'settings repair a saved URL on load, so a bad one heals',
    settingsSrc.includes('repairServerUrl(saved)')
  );

  // "Is the gateway on this phone?" is a different question from "is this local?",
  // and a screen that confuses them offers to start a gateway on a machine it
  // cannot reach. The LAN half is the one worth pinning: it *is* local, and it must
  // not be treated as this device.
  check('the loopback address the app defaults to', isLoopbackAddress('http://127.0.0.1:20128') === true);
  check('localhost, the other spelling of the same thing', isLoopbackAddress('http://localhost:20128') === true);
  check('loopback in IPv6, brackets and all', isLoopbackAddress('http://[::1]:20128') === true);
  check('a bare loopback address with no scheme', isLoopbackAddress('127.0.0.1:20128') === true);
  check('a LAN address is local but not this phone', isLoopbackAddress('http://192.168.1.10:20128') === false);
  check('a tunnel is neither', isLoopbackAddress('https://example.trycloudflare.com') === false);
  check('an unset address is not this phone either', isLoopbackAddress('') === false);
  check('and a malformed one does not become one by accident', isLoopbackAddress('http:///nope') === false);

  const installerSrc = readFileSync(join(root, 'lib', 'gatewayInstaller.ts'), 'utf8');
  check(
    'the local gateway URL is the http one, scheme included',
    installerSrc.includes('export const LOCAL_GATEWAY_URL = `http://127.0.0.1:${LOCAL_GATEWAY_PORT}`')
  );
} finally {
  rmSync(out, { recursive: true, force: true });
}

console.log(`\nurl:test — ${failures ? `FAILED (${failures} of ${checks})` : `OK (${checks} assertions)`}`);
process.exit(failures ? 1 : 0);
