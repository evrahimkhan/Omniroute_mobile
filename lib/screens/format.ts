/**
 * Small formatters shared by the surface renderers.
 *
 * The dashboard's payloads are full of keys like `ttlSeconds`, `isActive` and
 * `effectiveValue`. None of that belongs on a phone screen, so the renderers
 * humanise keys and format values here rather than in each screen.
 */

const ACRONYMS = new Set([
  'ai', 'api', 'a2a', 'ccr', 'cli', 'cpu', 'css', 'db', 'id', 'ip', 'jwt', 'llm', 'lru', 'mcp',
  'mitm', 'ms', 'omni', 'rtk', 'sse', 'ssl', 'tls', 'ttl', 'tts', 'ui', 'url', 'uuid', 'ws',
]);

/**
 * `enableStreaming` → `Enable streaming`, `ttl_seconds` → `TTL seconds`.
 * Acronyms stay upper case so a setting reads the way the dashboard's own label
 * does, instead of `Ttl Seconds`.
 */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.\-/]+/g, ' ')
    .trim()
    .split(/\s+/);

  const out = words.map((word, index) => {
    const lower = word.toLowerCase();
    if (ACRONYMS.has(lower)) return lower.toUpperCase();
    if (index === 0) return lower.charAt(0).toUpperCase() + lower.slice(1);
    return lower;
  });
  return out.join(' ');
}

/** A value as a single readable line. Never throws on odd payloads. */
export function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(Math.abs(value) < 1 ? 4 : 2).replace(/0+$/, '').replace(/\.$/, '');
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '—';
    // ISO timestamps read better as time-ago, which the rest of the app uses.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)) return formatTimestamp(trimmed);
    return trimmed.length > 160 ? `${trimmed.slice(0, 157)}…` : trimmed;
  }
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length ? `${keys.length} field${keys.length === 1 ? '' : 's'}` : 'empty';
  }
  return String(value);
}

/** `2026-10-02T10:00:00Z` → `2 Oct, 16:00` (local), falling back to the raw text. */
export function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${date.getDate()} ${months[date.getMonth()]}, ${hours}:${minutes}`;
}

/** A duration in milliseconds as `4h 12m` — the dashboard prints raw ms. */
export function formatDuration(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Bytes as `256 MB`. */
export function formatBytes(bytes: number | undefined): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes)) return undefined;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${bytes < 0 ? '-' : ''}${rounded} ${units[unit]}`;
}

/**
 * Whether a key looks like a secret. Values under these keys are masked in list
 * and detail views: the dashboard shows key material once, and a phone screen
 * that casually renders someone's API key is a screen that leaks it in a
 * screenshot.
 */
export function isSecretKey(key: string): boolean {
  return /(^|_)(api_?key|secret|token|password|passwd|credential|authorization|bearer|private_?key)(_|$)/i.test(key);
}

/** Should this key be hidden from a generic renderer (internal noise)? */
/** Internal plumbing: an id is shown as the row's title, not repeated as a field. */
export function isNoiseKey(key: string): boolean {
  return /^(id|_id|__v|revision|etag|uuid|tenantid|userid)$/i.test(key.replace(/[_-]/g, ''));
}
