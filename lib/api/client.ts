/**
 * The gateway's HTTP API, as the app uses it.
 *
 * The app used to be a WebView around the gateway's dashboard. It is not any
 * more: every screen calls this API and renders the result natively. That makes
 * two things this file's responsibility, and both are shaped by the fact that
 * the same code talks to a gateway on loopback *and* to a gateway on a tunnel:
 *
 *   - **The base URL is a setting, not a constant.** It comes from
 *     `lib/serverUrl.ts`, which decides http/https from the host, and it
 *     changes while the app is running (the "use this gateway" button).
 *   - **Failures must be legible.** A phone has no devtools. Every error this
 *     throws carries which URL was tried and what came back, because "Network
 *     error" on its own is what made a running gateway look dead.
 *
 * It also carries the session. Upstream's authz permits loopback requests in
 * bootstrap mode, so a fresh local gateway needs nothing; once a management
 * password exists, the dashboard session cookie is what authorises the call, and
 * React Native's fetch has no cookie jar — so the cookie is captured from the
 * login response and replayed by hand. See docs/NATIVE_UI.md.
 */

import { normalizeServerUrl } from '../serverUrl';

/** An HTTP failure with the status and the URL, so callers can say both. */
export class ApiError extends Error {
  readonly status: number | null;
  readonly url: string;
  readonly body: string;

  constructor(message: string, options: { status?: number | null; url: string; body?: string }) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status ?? null;
    this.url = options.url;
    this.body = options.body ?? '';
  }

  /** The gateway wants a dashboard session before it will answer. */
  get needsSignIn(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** Nothing answered at all — wrong URL, wrong scheme, gateway down. */
  get unreachable(): boolean {
    return this.status === null && !this.timedOut;
  }

  get timedOut(): boolean {
    return this.message.startsWith('Timed out');
  }
}

export interface ApiOptions {
  /** Base URL, as typed or saved. Normalised here. */
  base: string;
  /** Dashboard session cookie, when the app has signed in. */
  sessionCookie?: string | null;
  /** Convenience: an OmniRoute API key, sent as a bearer token. */
  apiToken?: string | null;
  /** Per-request timeout. Long enough for a cold Next.js route to compile. */
  timeoutMs?: number;
  /** Where the session cookie should be persisted when one arrives. */
  onSession?: (cookie: string) => void;
}

/**
 * The default timeout.
 *
 * The gateway is a Next.js server on a phone: the first request to a route can
 * spend several seconds in module loading, and a request that fans out to a
 * provider can take longer still. Fifteen seconds is the point where "slow" has
 * stopped being a plausible explanation for silence.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

/** A body that is not JSON, cut short for an error message. */
function snippet(text: string, max = 200): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function cookieFrom(headers: Headers): string | null {
  // React Native exposes `set-cookie` as a single string; some runtimes expose
  // several. Take the first name=value pair of whichever arrives.
  const raw =
    typeof (headers as { getSetCookie?: () => string[] }).getSetCookie === 'function'
      ? (headers as { getSetCookie: () => string[] }).getSetCookie().join(', ')
      : headers.get('set-cookie');
  if (!raw) return null;
  const first = raw.split(/,(?=[^;]+=)/)[0].trim();
  const pair = first.split(';')[0].trim();
  return pair.includes('=') ? pair : null;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Serialised as JSON. */
  body?: unknown;
  /** Appended as a query string; empty values are dropped. */
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Send without trying to parse a body (204s, streamed responses). */
  raw?: boolean;
  headers?: Record<string, string>;
}

export function buildQuery(query?: RequestOptions['query']): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/** A gateway URL for `path`, with the scheme rule applied. */
export function resolveUrl(base: string, path: string, query?: RequestOptions['query']): string {
  const root = normalizeServerUrl(base);
  if (!root) throw new ApiError('No gateway URL is configured', { url: path });
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${root}${p}${buildQuery(query)}`;
}

/**
 * Perform one request against the gateway.
 *
 * Written as a free function taking its configuration, so a test can drive it
 * against a local server without React, settings or a device — which is how
 * `scripts/check-api-client.mjs` exercises it.
 */
export async function apiRequest<T>(
  options: ApiOptions,
  path: string,
  request: RequestOptions = {}
): Promise<T> {
  const url = resolveUrl(options.base, path, request.query);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  // Cancelling the caller's signal must cancel ours.
  const onAbort = () => controller.abort();
  request.signal?.addEventListener('abort', onAbort);

  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(request.headers ?? {}),
  };
  if (request.body !== undefined) headers['content-type'] = 'application/json';
  if (options.sessionCookie) headers.cookie = options.sessionCookie;
  if (options.apiToken) headers.authorization = `Bearer ${options.apiToken}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: request.method ?? 'GET',
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    const timedOut = aborted && !request.signal?.aborted;
    throw new ApiError(
      timedOut
        ? `Timed out after ${Math.round(((request.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000))}s — no answer from ${url}`
        : `Network error — no answer from ${url}`,
      { url, status: null }
    );
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener('abort', onAbort);
  }

  // A session cookie can arrive on any response (the gateway refreshes it); it
  // is worth keeping whenever it does.
  const cookie = cookieFrom(response.headers);
  if (cookie && options.onSession) options.onSession(cookie);

  if (request.raw) {
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ApiError(`HTTP ${response.status} from ${url}`, {
        url,
        status: response.status,
        body: text,
      });
    }
    return response as unknown as T;
  }

  const text = await response.text().catch(() => '');

  if (!response.ok) {
    // Prefer the gateway's own message: its routes answer `{error: {message}}`,
    // `{error: "..."}` or `{message: "..."}`, and that text is usually the
    // whole answer (which field was wrong, which provider is missing).
    let detail = '';
    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
      const error = parsed?.error;
      detail =
        (typeof error === 'string' && error) ||
        (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
          ? String((error as { message: string }).message)
          : '') ||
        (typeof parsed?.message === 'string' ? parsed.message : '');
    } catch {
      detail = snippet(text);
    }
    throw new ApiError(
      detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status} from ${url}`,
      { url, status: response.status, body: text }
    );
  }

  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(`The gateway answered ${url} with something that is not JSON (${snippet(text, 80)})`, {
      url,
      status: response.status,
      body: text,
    });
  }
}

/** A client bound to one gateway — what screens actually use. */
export interface Api {
  readonly base: string;
  get<T>(path: string, options?: RequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  /** Some settings routes accept PUT only; sending PATCH would be ignored. */
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  del<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  /** Underlying options, for callers that need the raw request (streaming). */
  readonly options: ApiOptions;
}

export function createApi(options: ApiOptions): Api {
  const call = <T,>(method: RequestOptions['method'], path: string, body?: unknown, extra?: RequestOptions) =>
    apiRequest<T>(options, path, { ...extra, method, body });

  return {
    base: normalizeServerUrl(options.base),
    options,
    get: (path, extra) => call('GET', path, undefined, extra),
    post: (path, body, extra) => call('POST', path, body, extra),
    patch: (path, body, extra) => call('PATCH', path, body, extra),
    put: (path, body, extra) => call('PUT', path, body, extra),
    del: (path, body, extra) => call('DELETE', path, body, extra),
  };
}
