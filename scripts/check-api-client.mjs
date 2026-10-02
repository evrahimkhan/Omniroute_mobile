#!/usr/bin/env node
/**
 * Exercises the app's gateway client against a real (fake) gateway.
 *
 * Why this exists: the app no longer renders the dashboard in a WebView, so
 * every screen now depends on this client — the URL it builds, the errors it
 * reports, the session cookie it carries, and the tolerant readers that turn the
 * gateway's many response shapes into view models. A bug in any of them is a
 * blank screen on a phone with no devtools, which is exactly the class of
 * failure this repository's checks exist to catch.
 *
 * The server below is deliberately not a mock of the client: it is an HTTP
 * server the client talks to over a loopback socket, so the fetch path, headers,
 * status codes, redirects-off behaviour and streaming are all real. Everything
 * the gateway does that has bitten this app is reproduced here — a data route
 * that answers 401 without a session, an error body shaped `{error:{message}}`,
 * a route that returns HTML, and an SSE stream whose events are split across
 * chunks mid-UTF-8.
 *
 * It also asserts the invariant the whole refactor is about: no screen imports a
 * web view, and every destination in the menu points at a screen that exists.
 *
 *   node scripts/check-api-client.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let checks = 0;
let failures = 0;
function check(name, ok, extra) {
  checks += 1;
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${extra !== undefined ? `\n      ${extra}` : ''}`);
  }
}

// --------------------------------------------------------------- compilation

function compile() {
  const out = mkdtempSync(join(tmpdir(), 'api-client-'));
  const tsc = join(root, 'node_modules', '.bin', 'tsc');
  execFileSync(
    tsc,
    [
      'lib/serverUrl.ts',
      'lib/api/client.ts',
      'lib/api/shape.ts',
      'lib/api/resources.ts',
      'lib/api/chat.ts',
      '--outDir',
      out,
      '--module',
      'commonjs',
      '--target',
      'es2020',
      '--skipLibCheck',
      '--strict',
      '--ignoreConfig',
    ],
    { cwd: root, stdio: 'inherit' }
  );
  return out;
}

// ------------------------------------------------------------- fake gateway

function startGateway() {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    const cookie = req.headers.cookie ?? '';
    requests.push({ method: req.method, path, cookie, query: Object.fromEntries(url.searchParams), body: null });

    const json = (status, body, headers = {}) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(text);
    };

    const collect = (run) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        requests[requests.length - 1].body = body ? JSON.parse(body) : null;
        run();
      });
    };

    if (path === '/api/health') return json(200, { status: 'ok', timestamp: '2026-10-02T10:00:00.000Z' });
    if (path === '/api/telemetry/summary')
      return json(200, { uptime: 3_600_000, memoryUsage: 268_435_456, activeConnections: 3, errorRate: 0.012 });

    if (path === '/api/providers' && req.method === 'GET') {
      return json(200, {
        connections: [{ id: 'c1', provider: 'openai', isActive: true, apiKey: 'sk-secret' }],
        safeConnections: [
          { id: 'c1', provider: 'openai', isActive: true, accountLabel: 'me@example.com' },
          { id: 'c2', provider: 'anthropic', enabled: false },
        ],
      });
    }
    if (path === '/api/providers' && req.method === 'PATCH') {
      return collect(() => json(200, { message: 'ok', updated: 1, notFound: [] }));
    }

    if (path === '/api/models') {
      // Deliberately the `{models: [...]}` shape, with a namespaced id.
      return json(200, {
        models: [
          { id: 'openai/gpt-4o', displayName: 'GPT-4o', configured: true, contextLength: 128000 },
          'anthropic/claude-sonnet-4',
        ],
      });
    }

    if (path === '/api/keys' && req.method === 'GET') {
      return json(200, {
        keys: [
          { id: 'k1', name: 'Laptop', key: 'omni_live_0123456789abcdef', createdAt: new Date().toISOString(), requests: 42 },
          { id: 'k2', name: 'Old phone' },
          { id: 'k4', name: 'Masked', key: 'omni_live_0123…cdef', keyPreview: 'omni_live_0123…' },
        ],
        allowKeyReveal: true,
      });
    }
    if (path === '/api/keys' && req.method === 'POST') {
      return collect(() => json(200, { key: { id: 'k3', name: 'Phone', key: 'omni_live_fedcba9876543210' } }));
    }

    if (path === '/api/combos') {
      return json(200, {
        combos: [{ id: 'combo-1', name: 'Fallback', models: ['openai/gpt-4o', 'anthropic/claude-sonnet-4'], active: true }],
      });
    }

    if (path === '/api/usage/call-logs') {
      return json(200, {
        logs: [
          {
            id: 'r1',
            timestamp: new Date(Date.now() - 5000).toISOString(),
            model: 'openai/gpt-4o',
            provider: 'openai',
            statusCode: 200,
            latencyMs: 412,
            totalTokens: 1234,
            cost: 0.0123,
            apiKeyName: 'Laptop',
          },
          { id: 'r2', timestamp: new Date(Date.now() - 60_000).toISOString(), model: 'x', status: 'error' },
        ],
      });
    }

    if (path === '/api/auth/status') return json(200, { authenticated: cookie.includes('omniroute_session') });
    if (path === '/api/auth/login' && req.method === 'POST') {
      return collect(() =>
        json(200, { ok: true }, { 'set-cookie': 'omniroute_session=jwt-token; Path=/; HttpOnly; SameSite=Lax' })
      );
    }
    if (path === '/api/protected') {
      // The route that only answers with a session — the reason the client
      // carries a cookie at all.
      if (!cookie.includes('omniroute_session')) return json(401, { error: { message: 'Authentication required' } });
      return json(200, { ok: true });
    }

    // Errors the app has to explain: the gateway's own message, an HTML body,
    // and a validation failure.
    if (path === '/api/boom') return json(500, { error: { message: 'provider exploded' } });
    if (path === '/api/html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><h1>Sign in</h1>');
    }
    if (path === '/api/validate') return json(400, { error: [{ field: 'name', message: 'required' }] });

    // Chat: the advertised path 404s, exactly as it can on a build that only
    // serves /api/v1 — the client has to fall back rather than give up.
    if (path === '/v1/chat/completions') return json(404, { error: 'not found' });
    if (path === '/api/v1/chat/completions') {
      return collect(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // Split mid-event and mid-UTF-8 on purpose: a naive parser loses the
        // first delta or the emoji.
        const chunks = [
          'data: {"choices":[{"delta":{"content":"Hel',
          'lo"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" 👋"}}]}\n',
          '\n',
          'data: [DONE]\n\n',
        ];
        for (const chunk of chunks) res.write(chunk);
        res.end();
      });
    }

    json(404, { error: 'no such route' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, requests, base: `127.0.0.1:${server.address().port}` });
    });
  });
}

// -------------------------------------------------------------------- tests

const out = compile();
const { createApi, apiRequest, ApiError, buildQuery, resolveUrl } = require(join(out, 'api', 'client.js'));
const shape = require(join(out, 'api', 'shape.js'));
const resources = require(join(out, 'api', 'resources.js'));
const chat = require(join(out, 'api', 'chat.js'));

const { server, requests, base } = await startGateway();

try {
  // --- URL building, without a server -------------------------------------
  check(
    'a bare loopback address resolves to http',
    resolveUrl('127.0.0.1:20128', '/api/health') === 'http://127.0.0.1:20128/api/health'
  );
  check('a path without a slash still joins', resolveUrl('192.168.1.10:20128', 'api/health') === 'http://192.168.1.10:20128/api/health');
  check('empty query values are dropped', buildQuery({ a: 1, b: '', c: undefined, d: false }) === '?a=1&d=false');
  check('query values are encoded', buildQuery({ search: 'gpt 4o/x' }) === '?search=gpt%204o%2Fx');
  check(
    'an unconfigured gateway fails with a legible error',
    (() => {
      try {
        resolveUrl('', '/api/health');
        return false;
      } catch (err) {
        return err instanceof ApiError && /No gateway URL/.test(err.message);
      }
    })()
  );

  // --- the tolerant readers, against the gateway's real shapes -------------
  const api = createApi({ base });

  const health = await resources.getHealth(api);
  check('health is read from {status}', health.ok && health.status === 'ok');
  const telemetry = await resources.getTelemetry(api);
  check('telemetry maps uptime/memory/connections/errorRate', telemetry.uptimeMs === 3_600_000 && telemetry.memoryBytes === 268_435_456 && telemetry.activeConnections === 3);

  const providers = await resources.getProviders(api);
  check('providers prefer the redacted list', providers.length === 2 && !JSON.stringify(providers).includes('sk-secret'));
  check('a provider reads its active flag from isActive or enabled', providers[0].active === true && providers[1].active === false);
  check('a provider falls back to a title-cased name', providers[1].name === 'Anthropic');

  const patched = await resources.setProvidersActive(api, ['c1'], false);
  const patchBody = requests.filter((r) => r.path === '/api/providers' && r.method === 'PATCH').at(-1).body;
  check('turning a provider off sends {ids, isActive}', patched.updated === 1 && patchBody.ids[0] === 'c1' && patchBody.isActive === false);

  const models = await resources.getModels(api);
  check('models read from {models}', models.length === 2);
  check('a string model becomes an entry with a provider', models[1].id === 'anthropic/claude-sonnet-4' && models[1].provider === 'anthropic');
  check('a model keeps its configured flag', models[0].configured === true && models[0].contextLength === 128000);

  const keys = await resources.getKeys(api);
  check('keys read from {keys}', keys.keys.length === 3 && keys.allowReveal === true);
  check('a revealed key is offered for copying', keys.keys[0].secret === 'omni_live_0123456789abcdef');
  check('a masked key is not offered as a secret', keys.keys[2].secret === undefined && Boolean(keys.keys[2].hint));
  check('a key without a value still shows a hint', keys.keys[1].secret === undefined);
  const created = await resources.createKey(api, { name: 'Phone' });
  check('a created key keeps its one-time secret', created?.secret === 'omni_live_fedcba9876543210');

  const combos = await resources.getCombos(api);
  check('combos read their member list', combos[0].members.length === 2 && combos[0].members[0] === 'openai/gpt-4o');

  const logs = await resources.getCallLogs(api, { limit: 50, status: 'error' });
  check('call logs derive ok from a status code', logs[0].ok === true && logs[0].status === '200');
  check('a failed call is not ok', logs[1].ok === false);
  check(
    'a log summary names what it has',
    resources.logSummary(logs[0]).includes('412 ms') &&
      resources.logSummary(logs[0]).includes('1234 tok') &&
      resources.logSummary(logs[0]).includes('Laptop')
  );
  check('the log filters become query parameters', requests.at(-1).query.status === 'error' && requests.at(-1).query.limit === '50');

  // --- failures, as the screens will see them ------------------------------
  const boom = await resources.getHealth(api).then(
    () => null,
    (err) => err
  ).catch(() => null);
  check('a working health call is not an error', boom === null);

  const errorMessage = await api.get('/api/boom').then(
    () => null,
    (err) => err
  );
  check('a 500 surfaces the gateway’s own message', errorMessage instanceof ApiError && /provider exploded/.test(errorMessage.message));

  const html = await api.get('/api/html').then(
    () => null,
    (err) => err
  );
  check('an HTML body is reported as not JSON, not as a crash', html instanceof ApiError && /not JSON/.test(html.message));

  const unreachable = await apiRequest({ base: '127.0.0.1:1' }, '/api/health').then(
    () => null,
    (err) => err
  );
  check('an unreachable gateway names the URL it tried', unreachable instanceof ApiError && /no answer from http:\/\/127\.0\.0\.1:1\/api\/health/.test(unreachable.message) && unreachable.unreachable);

  const timedOut = await apiRequest({ base, timeoutMs: 60 }, '/api/slow').then(
    () => null,
    (err) => err
  );
  check('a timeout says so', timedOut === null || timedOut instanceof ApiError);

  // --- the session cookie --------------------------------------------------
  const noSession = await createApi({ base }).get('/api/protected').then(
    () => null,
    (err) => err
  );
  check('a route needing a session answers 401', noSession instanceof ApiError && noSession.needsSignIn);

  let captured = null;
  const signingIn = createApi({ base, onSession: (cookie) => (captured = cookie) });
  await signingIn.post('/api/auth/login', { password: 'hunter2' });
  check('the login response cookie is captured', captured === 'omniroute_session=jwt-token', String(captured));

  const session = createApi({ base, sessionCookie: captured });
  const protectedResult = await session.get('/api/protected');
  check('the cookie is replayed on the next request', protectedResult.ok === true);
  check('the cookie is sent as a Cookie header', requests.at(-1).cookie.includes('omniroute_session=jwt-token'));

  // --- streaming chat ------------------------------------------------------
  chat.__resetChatPathForTests();
  let streamed = '';
  const answer = await chat.streamChat(session, {
    model: 'openai/gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
    onDelta: (delta) => (streamed += delta),
  });
  check('chat falls back from /v1 to /api/v1', requests.some((r) => r.path === '/api/v1/chat/completions'));
  check('the streamed answer is complete', answer.text === 'Hello 👋', JSON.stringify(answer.text));
  check('deltas arrive incrementally, not as one blob', streamed === 'Hello 👋');
  check('the request asks for a stream', requests.at(-1).body.stream === true);
  const second = await chat.streamChat(session, { model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'again' }] });
  check('the working path is remembered, so the wrong one is not retried', second.text === 'Hello 👋');
  check('only one probe hit the 404 path', requests.filter((r) => r.path === '/v1/chat/completions').length === 1);

  // --- the reader primitives, on their own --------------------------------
  check('asArray finds a list inside a wrapper', shape.asArray({ anything: { items: [1, 2] } }).length === 2);
  check('asArray never invents a list', shape.asArray({ total: 0 }).length === 0);
  check('bool understands string flags', shape.bool('true') === true && shape.bool('inactive') === false);
  check('an absent flag stays absent', shape.bool(undefined) === undefined);
  check('num reads numbers and numeric strings', shape.num('42') === 42 && shape.num('x') === undefined);
  check('compactNumber shortens thousands', shape.compactNumber(12_345) === '12.3k');
  check('humanBytes scales units', shape.humanBytes(268_435_456) === '256 MB');
  check('scalarFields lists only scalars', shape.scalarFields({ a: 1, b: 'x', c: { nested: true }, d: null }).length === 2);
  check('relativeTime says "just now" for now', shape.relativeTime(new Date().toISOString()) === 'just now');
  check('titleCase reads a slug', shape.titleCase('gpt-4o_mini') === 'Gpt 4o mini');

  const sse = chat.createSseDecoder();
  const first = sse('data: {"a":1}\n\ndata: {"b":');
  const second2 = sse('2}\n\n');
  check('an SSE event split across chunks is delivered once, whole', first.length === 1 && second2.length === 1 && second2[0].data === '{"b":2}');
  check('a comment line is ignored', sse(': keep-alive\n\n').length === 0);
  check('a done sentinel yields no text', chat.deltaFromEvent('[DONE]') === null);
  check('a delta is extracted from the OpenAI shape', chat.deltaFromEvent('{"choices":[{"delta":{"content":"x"}}]}') === 'x');
  check('a malformed event is ignored, not thrown', chat.deltaFromEvent('not json') === null);

  // --- the invariant: nothing renders a web view ---------------------------
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(path);
      return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
    });

  const appFiles = [...walk(join(root, 'app')), ...walk(join(root, 'components')), ...walk(join(root, 'lib'))];
  // Imports only: these files *talk* about the WebView they replaced, and the
  // embedded bootstrap is a generated string that mentions it too.
  const webViewUsers = appFiles.filter((file) =>
    /react-native-webview|^\s*import[^;]*\bWebView\b/m.test(readFileSync(file, 'utf8'))
  );
  check('no screen imports a web view', webViewUsers.length === 0, webViewUsers.join(', '));

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  check('the web view dependency is gone', !pkg.dependencies['react-native-webview']);
  check('the catch-all web route is gone', !existsSync(join(root, 'app', 'feature')));
  check('the web data helper is gone', !existsSync(join(root, 'lib', 'webData.ts')));
  check('the 94-item web feature index is gone', !existsSync(join(root, 'lib', 'features.ts')));

  // Every destination the menu offers must be a screen that exists. A dead menu
  // entry is exactly the failure a native app must not have, because it cannot
  // fall back to the browser any more.
  const destinations = readFileSync(join(root, 'lib', 'destinations.ts'), 'utf8');
  const routes = [...destinations.matchAll(/route:\s*'([^']+)'/g)].map((m) => m[1]);
  const missingRoutes = routes.filter((route) => {
    const cleaned = route.replace(/^\//, '').replace('/(tabs)', '(tabs)').replace(/^\/*/, '');
    const candidates = [
      join(root, 'app', `${cleaned.replace(/^\(tabs\)\//, '(tabs)/')}.tsx`),
      join(root, 'app', cleaned.replace(/^\(tabs\)\//, '(tabs)/'), 'index.tsx'),
      join(root, 'app', `${cleaned}.tsx`),
    ];
    return !candidates.some((candidate) => existsSync(candidate.replace('/(tabs)//', '/(tabs)/')));
  });
  check(
    `every menu destination (${routes.length}) is a real screen`,
    missingRoutes.length === 0,
    missingRoutes.join(', ')
  );
  check('the menu is searchable and declared once', /NATIVE_DESTINATIONS/.test(destinations) && /DestinationSection/.test(destinations));
} finally {
  server.close();
  rmSync(out, { recursive: true, force: true });
}

console.log(`\napi:test — ${failures ? `FAILED (${failures} of ${checks})` : `OK (${checks} assertions)`}`);
process.exit(failures ? 1 : 0);
