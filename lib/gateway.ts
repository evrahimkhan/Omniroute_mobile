import { looksLikeHtml, websiteMessage } from './api/client';
/**
 * Gateway URL helpers + health probing.
 *
 * The app talks to an OmniRoute gateway instance — the one hosted on this phone
 * or one the user runs elsewhere. This file keeps URLs sane and probes the
 * gateway's own liveness routes. It deliberately never probes `/`: a website
 * answering there is not a gateway, and treating it as one is how a marketing
 * site came to look "Online" while every screen 404'd.
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
  /** What answered: the gateway API, a web page, or nothing at all. */
  kind?: 'gateway' | 'website' | 'nothing';
}

/**
 * Probe the gateway. `/healthz` is a lightweight liveness route shipped by
 * OmniRoute; we fall back to the dashboard itself if it 404s on older builds.
 */
export async function checkGateway(serverUrl: string, timeoutMs = 10000): Promise<GatewayStatus> {
  const base = normalizeServerUrl(serverUrl);
  if (!base) return { ok: false, detail: 'No gateway URL configured', kind: 'nothing' };

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let sawWebPage = false;
  let lastStatus: number | undefined;
  let answered = false;

  try {
    // Ask for the API this app actually uses, never for `/`.
    //
    // Falling back to the dashboard — `/` — was the bug: a website answering 200
    // there was reported as an online gateway, so pointing the app at
    // omniroute.online (the project's marketing site) looked like a successful
    // connection right up until every screen 404'd.
    for (const path of ['/api/health', '/healthz', '/livez']) {
      try {
        const res = await fetch(gatewayUrl(base, path), {
          signal: controller.signal,
          redirect: 'follow',
          headers: { accept: 'application/json' },
        });
        const latencyMs = Date.now() - started;
        const text = await res.text().catch(() => '');
        answered = true;

        if (looksLikeHtml(text)) {
          // A page here is proof of what the address is: not a gateway.
          sawWebPage = true;
          lastStatus = res.status;
          continue;
        }
        if (res.ok) return { ok: true, status: res.status, latencyMs, kind: 'gateway' };
        lastStatus = res.status;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') break;
      }
    }

    if (sawWebPage) {
      return { ok: false, status: lastStatus, kind: 'website', detail: websiteMessage(base) };
    }
    if (!answered) {
      return { ok: false, kind: 'nothing', detail: `Network error — no answer from ${base}` };
    }
    return {
      ok: false,
      status: lastStatus,
      kind: 'gateway',
      detail: `Reached ${base} but no gateway route answered (last: HTTP ${lastStatus})`,
    };
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
