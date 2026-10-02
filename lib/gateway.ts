/**
 * Gateway URL helpers + health probing.
 *
 * The mobile app is a native shell around an OmniRoute gateway instance
 * (self-hosted or https://omniroute.online). All dashboard pages are served
 * by that gateway; this file keeps URLs sane and probes `/healthz`.
 */

import { normalizeServerUrl } from './serverUrl';

// The scheme rule lives in lib/serverUrl.ts, where a test exercises it directly
// (scripts/check-server-url.mjs). Re-exported so callers keep one import.
export { normalizeServerUrl, repairServerUrl, assumedScheme, isLocalHost } from './serverUrl';

export function gatewayUrl(serverUrl: string, path: string): string {
  const base = normalizeServerUrl(serverUrl);
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${base}${p}`;
}

export function isExternalUrl(path: string): boolean {
  return /^https?:\/\//i.test(path);
}

export interface GatewayStatus {
  ok: boolean;
  status?: number;
  latencyMs?: number;
  detail?: string;
}

/**
 * Probe the gateway. `/healthz` is a lightweight liveness route shipped by
 * OmniRoute; we fall back to the dashboard itself if it 404s on older builds.
 */
export async function checkGateway(serverUrl: string, timeoutMs = 10000): Promise<GatewayStatus> {
  const base = normalizeServerUrl(serverUrl);
  if (!base) return { ok: false, detail: 'No gateway URL configured' };

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (const path of ['/healthz', '/livez', '/']) {
      try {
        const res = await fetch(gatewayUrl(base, path), {
          signal: controller.signal,
          redirect: 'follow',
        });
        const latencyMs = Date.now() - started;
        if (res.ok) return { ok: true, status: res.status, latencyMs };
        // Keep the last non-ok status for reporting, but try next path.
        const detail = `HTTP ${res.status}`;
        if (path === '/') return { ok: false, status: res.status, latencyMs, detail };
      } catch (err) {
        if (path === '/') {
          // Name the URL that was tried: "Network error" on its own is what
          // makes a working gateway look unreachable, and the scheme is the
          // first thing to question.
          const why = err instanceof Error && err.name === 'AbortError' ? 'Timed out' : 'Network error';
          return { ok: false, detail: `${why} — no answer from ${base}` };
        }
      }
    }
    return { ok: false, detail: 'Gateway reachable but no liveness route responded' };
  } finally {
    clearTimeout(timer);
  }
}

export function hostOf(serverUrl: string): string {
  try {
    return new URL(normalizeServerUrl(serverUrl)).host;
  } catch {
    return serverUrl;
  }
}
