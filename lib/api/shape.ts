/**
 * Reading the gateway's JSON without knowing all of it.
 *
 * The gateway has 723 API routes, written for its own dashboard. Their payloads
 * are typed where the dashboard needs them and loose where it does not: the same
 * list arrives as `[...]`, `{items: [...]}` or `{models: [...]}` depending on the
 * route, ids are sometimes `id` and sometimes `<resource>_id`, and booleans are
 * sometimes `isActive` and sometimes `active` or `"true"`.
 *
 * A native screen cannot be rewritten every time a field name moves, so it does
 * not guess: it normalises. Everything here is a *lossless* reader — it never
 * invents a value, and it reports `undefined` rather than a plausible default,
 * so a screen can say "not reported" instead of showing a confident zero.
 */

export type Json = Record<string, unknown>;

export function asRecord(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

/**
 * Find the first array in `value`, or in one of `keys` when it is an object.
 *
 * This is the single most useful reader: it lets a list screen work against
 * `{models: [...]}`, `{items: [...]}`, `{data: {...}}` and a bare array without
 * a branch per endpoint.
 */
export function asArray(value: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return [];
  for (const key of keys) {
    const found = record[key];
    if (Array.isArray(found)) return found;
    const nested = asRecord(found);
    if (nested) {
      for (const inner of ['items', 'data', 'results', 'rows']) {
        if (Array.isArray(nested[inner])) return nested[inner] as unknown[];
      }
    }
  }
  // Last resort: the first array-valued property, or the first list inside an
  // implicitly named wrapper (`{anything: {items: [...]}}`). Better than
  // returning nothing for a route whose wrapper name we have never seen.
  for (const candidate of Object.values(record)) {
    if (Array.isArray(candidate)) return candidate;
  }
  for (const candidate of Object.values(record)) {
    const nested = asRecord(candidate);
    if (!nested) continue;
    for (const inner of Object.values(nested)) {
      if (Array.isArray(inner)) return inner;
    }
  }
  return [];
}

/** The first present, non-empty value among `keys`. */
export function pick(record: Json | null, ...keys: string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

export function str(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

/** A string from the first present key. */
export function pickStr(record: Json | null, ...keys: string[]): string {
  return str(pick(record, ...keys));
}

export function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function pickNum(record: Json | null, ...keys: string[]): number | undefined {
  return num(pick(record, ...keys));
}

/**
 * A boolean, however it is spelled.
 *
 * Absent means absent: `undefined`, not `false`. "The gateway did not say" and
 * "the gateway said no" lead to different UI, and only one of them is a claim
 * about the gateway.
 */
export function bool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const lowered = value.toLowerCase();
    if (['true', '1', 'yes', 'on', 'active', 'enabled'].includes(lowered)) return true;
    if (['false', '0', 'no', 'off', 'inactive', 'disabled'].includes(lowered)) return false;
  }
  return undefined;
}

export function pickBool(record: Json | null, ...keys: string[]): boolean | undefined {
  return bool(pick(record, ...keys));
}

/** Numbers and bytes, for a phone screen. */
export function compactNumber(value: number | undefined): string {
  if (value === undefined) return '—';
  if (Math.abs(value) >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 10_000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

export function humanBytes(value: number | undefined): string {
  if (value === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size < 10 && unit > 0 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

export function humanDuration(ms: number | undefined): string {
  if (ms === undefined) return '—';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** "3 minutes ago" — the only timestamp format a log list needs. */
export function relativeTime(value: unknown, now = Date.now()): string {
  const raw = typeof value === 'number' ? value : Date.parse(str(value));
  if (!Number.isFinite(raw)) return '';
  const ms = Date.now() - raw > 0 && now === Date.now() ? now - raw : now - raw;
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** A short, copyable id: enough to match a log line, short enough for a chip. */
export function shortId(value: string): string {
  return value.length > 10 ? value.slice(0, 8) : value;
}

/** Every scalar field of a record, for a detail sheet that never lies. */
export function scalarFields(record: Json | null, limit = 24): Array<{ key: string; value: string }> {
  if (!record) return [];
  const out: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') continue;
    if (value === '') continue;
    out.push({ key, value: str(value) });
    if (out.length >= limit) break;
  }
  return out;
}

export function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^\w/, (c) => c.toUpperCase());
}
