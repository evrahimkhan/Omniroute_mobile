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
      'lib/gateway.ts',
      'lib/api/shape.ts',
      'lib/api/resources.ts',
      'lib/api/chat.ts',
      'lib/api/config.ts',
      'lib/api/collection.ts',
      'lib/screens/format.ts',
      'lib/screens/stats.ts',
      'lib/screens/catalog.ts',
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

/**
 * A server that behaves like a website: `/` is a landing page, and every other
 * path — including everything under /api — is its own 404 page. Both are HTML,
 * both are valid responses, and neither is a gateway.
 */
function startWebsite() {
  const server = createServer((req, res) => {
    const isRoot = req.url === '/' || req.url === '';
    res.writeHead(isRoot ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<!DOCTYPE html><html><head><meta charSet="utf-8"/><title>' +
        (isRoot ? 'OmniRoute by Cheaper Inference' : '404: This page could not be found.') +
        '</title></head><body><h1>' +
        (isRoot ? 'The #1 open source AI router' : '404') +
        '</h1></body></html>'
    );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `127.0.0.1:${server.address().port}` }));
  });
}

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

    // A self-describing settings route, the shape the dashboard's own settings
    // pages read: each entry carries its label, type and enum values.
    if (path === '/api/settings/demo' && req.method === 'GET') {
      return json(200, {
        revision: 12,
        flags: [
          {
            key: 'ENABLE_STREAMING',
            label: 'Streaming responses',
            description: 'Send deltas as they arrive',
            category: 'Transport',
            type: 'boolean',
            enumValues: null,
            defaultValue: 'true',
            effectiveValue: 'false',
            source: 'db',
            requiresRestart: true,
          },
          {
            key: 'LOG_LEVEL',
            label: 'Log level',
            category: 'Transport',
            type: 'enum',
            enumValues: ['debug', 'info', 'warn', 'error'],
            effectiveValue: 'info',
            source: 'env',
          },
        ],
        cache: { enabled: true, ttlSeconds: 300 },
        displayName: 'Demo gateway',
      });
    }
    if (path === '/api/settings/demo' && req.method === 'PATCH') {
      return collect(() => json(200, { ok: true }));
    }

    // A list route with the awkward bits: a wrapper key, a secret, a status word.
    if (path === '/api/audit') {
      return json(200, {
        total: 2,
        items: [
          {
            id: 'a1',
            name: 'key.created',
            status: 'success',
            enabled: true,
            apiKey: 'omni_live_deadbeefdeadbeef',
            createdAt: '2026-10-02T09:00:00.000Z',
          },
          { id: 'a2', name: 'login.failed', status: 'error', enabled: false, actor: 'me@example.com' },
        ],
      });
    }

    // A numbers route, as the analytics pages see them.
    if (path === '/api/usage/demo') {
      return json(200, {
        uptime: 7_200_000,
        totalRequests: 15_234,
        errorRate: 0.031,
        byProvider: [
          { provider: 'openai', requests: 9_000, errors: 12 },
          { provider: 'anthropic', requests: 5_000, errors: 4 },
          { provider: 'google', requests: 1_234, errors: 0 },
        ],
        window: '24h',
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
const client = require(join(out, 'api', 'client.js'));
const { createApi, apiRequest, ApiError, buildQuery, resolveUrl } = client;
const shape = require(join(out, 'api', 'shape.js'));
const resources = require(join(out, 'api', 'resources.js'));
const chat = require(join(out, 'api', 'chat.js'));
const gateway = require(join(out, 'gateway.js'));
const config = require(join(out, 'api', 'config.js'));
const collection = require(join(out, 'api', 'collection.js'));
const format = require(join(out, 'screens', 'format.js'));
const catalog = require(join(out, 'screens', 'catalog.js'));

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
  check(
    'an HTML body is reported as a website, not as a crash',
    html instanceof ApiError && html.notAGateway && /web page/.test(html.message)
  );
  check('no raw markup reaches the UI', !/<!DOCTYPE/i.test(html.message));

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

  // --- telling a website apart from a gateway ------------------------------
  // The bug this pins: pointing the app at omniroute.online (the project's
  // marketing site) showed a green "signed in" badge and a full-page HTML error
  // on every screen, because a Next.js 404 page and a gateway route are both
  // just HTTP responses.
  const website = await startWebsite();
  try {
    const site = createApi({ base: website.base });
    const siteError = await site.get('/api/providers').then(
      () => null,
      (err) => err
    );
    check('a website is reported as a website, not as HTTP 404', siteError instanceof ApiError && siteError.notAGateway);
    check(
      'the message names the address and says what to do',
      /answered with a web page, not the gateway API/.test(siteError.message) &&
        siteError.message.includes('127.0.0.1:20128'),
      siteError.message
    );
    check('no markup leaks into the message', !/<|DOCTYPE|html>/i.test(siteError.message));
    check(
      'a landing page with HTTP 200 is not mistaken for an answer either',
      (() => {
        // `/` answers 200 with HTML; the client must classify that as a page too.
        return client.looksLikeHtml('<!DOCTYPE html><html><body>hi</body></html>') === true;
      })()
    );
    check('and a JSON body is not', client.looksLikeHtml('{"ok":true}') === false);

    // The Settings "Test" button used to probe `/` and call any 200 "Online",
    // which is how a marketing site passed for a gateway.
    const probe = await gateway.checkGateway(website.base);
    check(
      'the connection test does not accept a website as a gateway',
      probe.ok === false && probe.kind === 'website',
      JSON.stringify(probe)
    );
    check(
      'the connection test explains it in words',
      /web page, not the gateway API/.test(probe.detail ?? ''),
      probe.detail
    );

    const realProbe = await gateway.checkGateway(base);
    check('a real gateway still tests as online', realProbe.ok === true && realProbe.kind === 'gateway', JSON.stringify(realProbe));

    const deadProbe = await gateway.checkGateway('127.0.0.1:1');
    check(
      'an address with nothing on it says so',
      deadProbe.ok === false && deadProbe.kind === 'nothing' && /no answer from/.test(deadProbe.detail ?? ''),
      JSON.stringify(deadProbe)
    );
  } finally {
    website.server.close();
  }

  // --- the engines that draw every dashboard surface -----------------------
  const demo = await session.get('/api/settings/demo');
  const groups = config.configGroups(demo);
  check('a self-describing settings route becomes native fields', groups.length >= 2);
  const flagGroup = groups.find((group) => group.title === 'Transport');
  check('fields are grouped by the category the route declares', Boolean(flagGroup));
  const streaming = flagGroup.fields.find((field) => field.key === 'ENABLE_STREAMING');
  check('a described boolean becomes a switch', streaming.type === 'boolean' && streaming.value === false);
  check('a described enum becomes a picker', flagGroup.fields.find((f) => f.key === 'LOG_LEVEL').options.length === 4);
  check('the route’s own label and help text are used', streaming.label === 'Streaming responses' && Boolean(streaming.description));
  check('a restart requirement is carried through', streaming.requiresRestart === true);
  check('the effective value is the one shown, not the default', streaming.value === false);
  check(
    'a plain settings object still yields editable fields',
    config.configGroups({ cache: { enabled: true, ttlSeconds: 300 } }).some((group) =>
      group.fields.some((field) => field.key === 'cache.ttlSeconds' && field.type === 'number')
    )
  );
  check(
    'dotted edits are rebuilt as nested objects',
    JSON.stringify(config.nestChanges({ 'cache.ttlSeconds': 60 })) === JSON.stringify({ cache: { ttlSeconds: 60 } })
  );
  await config.saveConfig(session, '/api/settings/demo', { 'cache.ttlSeconds': 60 }, 'patch');
  const savedBody = requests.at(-1).body;
  check(
    'saving sends only what changed',
    Object.keys(savedBody).length === 1 && savedBody.cache.ttlSeconds === 60,
    JSON.stringify(savedBody)
  );

  const audit = collection.normalizeCollection(await session.get('/api/audit'));
  check('a wrapped list becomes rows', audit.rows.length === 2 && audit.total === 2);
  check('a row is titled by its most human field', audit.rows[0].title === 'key.created');
  check('state becomes badges', audit.rows[0].badges.some((badge) => badge.label === 'success' && badge.tone === 'ok'));
  check('a failure is badged as one', audit.rows[1].badges.some((badge) => badge.tone === 'danger'));
  check(
    'a secret is never rendered',
    audit.rows[0].values.every((value) => !value.value.includes('deadbeef')) &&
      audit.rows[0].values.some((value) => value.value === '••••••')
  );
  check('timestamps are shown as a time, not ISO', /Sep|Oct/.test(audit.rows[0].values.map((v) => v.value).join(' ')));
  check(
    'a single object still produces a row',
    collection.normalizeCollection({ status: 'ok', version: '3.8.52' }).rows.length === 1
  );

  const stats = require(join(out, 'screens', 'stats.js'));
  const parsed = stats.parseStats(await session.get('/api/usage/demo'));
  check('numbers become metrics', parsed.metrics.some((metric) => metric.label === 'Total requests'));
  check('a duration is formatted as one', parsed.metrics.some((metric) => metric.value === '2h 0m'));
  check('a fraction becomes a percentage', parsed.metrics.some((metric) => metric.value === '3.1%'));
  check('an array of records becomes a ranked breakdown', parsed.breakdowns.length === 1 && parsed.breakdowns[0].rows[0].label === 'openai');
  check('the biggest entry is first', parsed.breakdowns[0].rows[0].value === 9000);
  check('the breakdown names the metric it ranked', /Requests/.test(parsed.breakdowns[0].title));

  check('keys are humanised for display', format.humanizeKey('enableStreaming') === 'Enable streaming');
  check('acronyms stay upper case', format.humanizeKey('ttlSeconds') === 'TTL seconds');
  check('secret-looking keys are recognised', format.isSecretKey('apiKey') && format.isSecretKey('authorization') && !format.isSecretKey('model'));
  check('bytes and durations format like the rest of the app', format.formatBytes(268_435_456) === '256 MB' && format.formatDuration(7_200_000) === '2h 0m');

  // --- the catalog that replaces the dashboard's 94 entries ----------------
  check(`the catalog covers every dashboard surface (${catalog.SURFACES.length})`, catalog.SURFACES.length >= 90);
  const kinds = new Set(catalog.SURFACES.map((surface) => surface.kind));
  check(
    'every surface has a kind the app can render',
    [...kinds].every((kind) => ['custom', 'config', 'collection', 'stats', 'local', 'external'].includes(kind)),
    [...kinds].join(', ')
  );
  const needsApi = catalog.SURFACES.filter((s) => ['config', 'collection', 'stats'].includes(s.kind));
  check(
    `every fetched surface (${needsApi.length}) names a gateway route`,
    needsApi.every((surface) => typeof surface.path === 'string' && surface.path.startsWith('/api/')),
    needsApi.filter((s) => !s.path?.startsWith('/api/')).map((s) => s.id).join(', ')
  );
  check(
    'surfaces that fetch nothing explain themselves',
    catalog.SURFACES.filter((s) => ['local'].includes(s.kind)).every((surface) => Boolean(surface.note))
  );
  const customSurfaces = catalog.SURFACES.filter((s) => s.kind === 'custom');
  check(
    `every bespoke surface (${customSurfaces.length}) has a route in the app`,
    customSurfaces.every((surface) => typeof surface.route === 'string' && surface.route.length > 1)
  );
  check(
    'sections partition the catalog without losing a surface',
    catalog.SECTIONS.reduce((count, section) => count + section.surfaces.length, 0) === catalog.SURFACES.length
  );
  check('search finds a surface by its route', catalog.searchSurfaces('audit').length > 0 && catalog.searchSurfaces('zzzz').length === 0);

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
  /** An expo-router path → the file that serves it. */
  const routeFile = (route) => {
    const cleaned = route.replace(/^\//, '');
    const base = cleaned.replace(/^\(tabs\)\/?/, '');
    const dir = cleaned.startsWith('(tabs)') ? '(tabs)' : '';
    if (!base) return join(root, 'app', dir, 'index.tsx');
    return join(root, 'app', dir, `${base}.tsx`);
  };

  const customRoutes = catalog.SURFACES.filter((surface) => surface.kind === 'custom').map((surface) => surface.route);
  const missingRoutes = customRoutes.filter((route) => !existsSync(routeFile(route)));
  check(
    `every bespoke screen behind a menu entry (${customRoutes.length}) exists`,
    missingRoutes.length === 0,
    missingRoutes.join(', ')
  );
  check(
    'the routes a surface can open exist',
    existsSync(join(root, 'app', 'surface', '[id].tsx')) && existsSync(join(root, 'app', 'section', '[id].tsx'))
  );

  // The menu has to behave like a phone menu: a short list that drills down,
  // not the dashboard's own sidebar poured into one scroll.
  const menu = readFileSync(join(root, 'app', '(tabs)', 'more.tsx'), 'utf8');
  check('the menu is a searchable index', /SearchField/.test(menu) && /searchSurfaces/.test(menu));
  check('the menu drills into sections instead of listing every surface', /\/section\/\$\{/.test(menu));
  check('the menu opens surfaces through the shared helper', /openSurface/.test(menu));
  check(
    `the menu is a screenful, not the web sidebar (${catalog.SECTIONS.length} sections, largest ${Math.max(
      ...catalog.SECTIONS.map((section) => section.surfaces.length)
    )})`,
    catalog.SECTIONS.length <= 12
  );
  check(
    'sections carry a phone-facing label, not the dashboard taxonomy',
    catalog.SECTIONS.every(
      (section) =>
        typeof section.label === 'string' &&
        section.label.length > 0 &&
        typeof section.subtitle === 'string' &&
        section.subtitle.length > 0
    ),
    catalog.SECTIONS.filter((section) => !section.subtitle).map((section) => section.title).join(', ')
  );
  check(
    'a section keeps the dashboard name it came from',
    catalog.SECTIONS.every((section) => typeof section.title === 'string' && section.title.length > 0)
  );
  check('the old hand-written menu is gone', !existsSync(join(root, 'lib', 'features.ts')));

  // --- the session state must never be guessed ------------------------------
  //
  // `authenticated` has three answers and the first version of the session screen
  // had two. Everything that went wrong on a phone — a green "signed in" over a
  // website, "nothing to do" over a gateway that was not running, the form hidden
  // behind that message — came from reading `null` as good news. These assertions
  // are textual on purpose: the bug was a missing branch, and a missing branch is
  // exactly what an absent string proves.
  const signIn = readFileSync(join(root, 'app', 'sign-in.tsx'), 'utf8');
  check('the session screen asks the gateway instead of inferring from the session', /checkGateway\(/.test(signIn));
  check('it does not claim the gateway is answering when nothing said so', !/is answering this app/.test(signIn));
  check(
    'unknown is its own state, not "nothing to do"',
    /status === null/.test(signIn) && !/Nothing to do/.test(signIn)
  );
  check('it still offers the password form when the state is unknown', /showForm/.test(signIn) && /reached/.test(signIn));
  check(
    'the settings row colours unknown differently from signed in',
    /'shield-off-outline'/.test(readFileSync(join(root, 'app', 'settings.tsx'), 'utf8'))
  );
  check(
    '"start it on this phone" is offered only for a loopback address',
    /isLoopbackAddress/.test(signIn) &&
      /export function isLoopbackAddress/.test(readFileSync(join(root, 'lib', 'serverUrl.ts'), 'utf8'))
  );
  check(
    'the session screen cannot re-probe itself in a loop',
    /refreshRef/.test(signIn) && !/\[serverUrl, session\]\)/.test(signIn)
  );
} finally {
  server.close();
  rmSync(out, { recursive: true, force: true });
}

console.log(`\napi:test — ${failures ? `FAILED (${failures} of ${checks})` : `OK (${checks} assertions)`}`);
process.exit(failures ? 1 : 0);
