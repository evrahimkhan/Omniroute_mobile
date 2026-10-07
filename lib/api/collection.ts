/**
 * List-shaped surfaces: a route that returns rows, rendered natively.
 *
 * Every dashboard list page is the same problem — fetch a route, show records,
 * open one, sometimes delete it — so the app solves it once. Rows are described
 * by what the payload contains rather than by a per-screen schema: a title from
 * the first human-looking field, a subtitle from the next, badges from any
 * boolean that sounds like state, and the remaining scalars in the detail view.
 */

import type { Api } from './client';
import { asArray, asRecord, scalarFields, type Json } from './shape';
import { formatScalar, humanizeKey, isNoiseKey, isSecretKey } from '../screens/format';

export interface CollectionRow {
  id: string;
  title: string;
  subtitle?: string;
  badges: { label: string; tone: 'muted' | 'ok' | 'warn' | 'danger' }[];
  /** Everything readable about the row, in a stable order, for the detail view. */
  values: { label: string; value: string }[];
  raw: Json;
}

export interface Collection {
  rows: CollectionRow[];
  /** The route's own count, when it reports one. */
  total?: number;
  /** True when the payload was a single object rendered as one row. */
  single: boolean;
}

const TITLE_KEYS = [
  'name', 'title', 'label', 'displayName', 'model', 'modelId', 'provider', 'providerId', 'id',
  'key', 'slug', 'email', 'username', 'url', 'endpoint', 'host', 'tool', 'agent', 'sessionId',
  'correlationId', 'path', 'method', 'type', 'kind', 'message',
];
const SUBTITLE_KEYS = [
  'description', 'subtitle', 'summary', 'detail', 'message', 'error', 'note', 'accountLabel',
  'account', 'baseUrl', 'origin', 'provider', 'model',
];
const STATE_KEYS = [
  'active', 'enabled', 'isActive', 'isEnabled', 'healthy', 'ok', 'success', 'isDefault',
  'configured', 'connected', 'available', 'paused', 'running',
];

/** Keys whose `true` is good news, so a badge can be honest about the direction. */
const POSITIVE_STATE = /^(active|enabled|isactive|isenabled|healthy|ok|success|isdefault|configured|connected|available|running)$/i;

function pickFirst(record: Json, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
  }
  return undefined;
}

/** The most human-looking title for a record, deterministic across reloads. */
export function rowTitle(record: Json): string {
  const direct = pickFirst(record, TITLE_KEYS);
  if (direct) return direct.length > 80 ? `${direct.slice(0, 77)}…` : direct;
  const strings = scalarFields(record).filter((entry) => typeof entry.value === 'string' && entry.value.length > 2);
  if (strings.length) return String(strings[0].value).slice(0, 80);
  return 'Record';
}

function toneForStatus(status: string): 'muted' | 'ok' | 'warn' | 'danger' {
  if (/error|fail|down|invalid|blocked|denied|timeout|revoked|expired/i.test(status)) return 'danger';
  if (/warn|degrad|retry|pending|partial|unknown/i.test(status)) return 'warn';
  if (/ok|success|up|active|healthy|complete|ready|connected/i.test(status)) return 'ok';
  return 'muted';
}

function badgesFor(record: Json): CollectionRow['badges'] {
  const badges: CollectionRow['badges'] = [];

  const status = record.status;
  if (typeof status === 'string' && status) {
    badges.push({ label: status, tone: toneForStatus(status) });
  } else if (typeof record.statusCode === 'number') {
    badges.push({ label: String(record.statusCode), tone: record.statusCode < 400 ? 'ok' : 'danger' });
  }

  for (const key of STATE_KEYS) {
    const value = record[key];
    if (typeof value !== 'boolean') continue;
    const label = humanizeKey(key);
    // `not Enabled` for a negative value would read as a double negative on the
    // ones where true is the good state, so those stay signed.
    const text = value ? label : POSITIVE_STATE.test(key) ? `not ${label.toLowerCase()}` : label;
    badges.push({ label: text, tone: value ? 'ok' : 'muted' });
    if (badges.length >= 4) break;
  }

  return badges.slice(0, 4);
}

/** One record as a row: everything scalar, secrets masked, noise dropped. */
export function toRow(record: Json, index: number): CollectionRow {
  const values = scalarFields(record)
    .filter((field) => !isNoiseKey(field.key))
    .map((field) => ({
      label: humanizeKey(field.key),
      value: isSecretKey(field.key) ? '••••••' : formatScalar(field.value),
    }));

  return {
    id: String(record.id ?? record.key ?? record.name ?? record.model ?? index),
    title: rowTitle(record),
    subtitle: pickFirst(record, SUBTITLE_KEYS.filter((key) => key !== record.name)),
    badges: badgesFor(record),
    values,
    raw: record,
  };
}

/**
 * Turn a payload into rows without knowing which wrapper the route used.
 *
 * Routes differ: `{keys:[…]}`, `{items:[…]}`, a bare array, or a single object
 * for a status route. All four are handled, and a single object still produces
 * one row so a "list" screen over a status route shows something real.
 */
export function normalizeCollection(payload: unknown): Collection {
  const direct = Array.isArray(payload) ? payload : null;
  const list = direct ?? asArray(payload);
  const record = asRecord(payload);

  const asRecords = list.map((entry) => asRecord(entry)).filter((entry): entry is Json => Boolean(entry));
  const rows = asRecords.map((entry, index) => toRow(entry, index));

  if (rows.length) {
    const total =
      record && typeof record.total === 'number'
        ? record.total
        : record && typeof record.count === 'number'
          ? record.count
          : undefined;
    return { rows, total, single: false };
  }

  // No array anywhere: a single object is still worth showing as one row.
  if (record && Object.keys(record).length > 0) {
    const interesting = Object.keys(record).filter((key) => !isNoiseKey(key));
    if (interesting.length >= 2) return { rows: [toRow(record, 0)], single: true };
  }

  return { rows: [], single: false };
}

export async function readCollection(
  api: Api,
  path: string,
  query?: Record<string, string | number | boolean | undefined>
): Promise<Collection> {
  return normalizeCollection(await api.get<unknown>(path, query ? { query } : undefined));
}

/** Rows the app is willing to draw at once; the rest are summarised. */
export const RENDER_LIMIT = 300;

export async function createRow(
  api: Api,
  path: string,
  data: Record<string, unknown>
): Promise<unknown> {
  return await api.post<unknown>(path, data);
}

export async function updateRow(
  api: Api,
  path: string,
  id: string,
  data: Record<string, unknown>
): Promise<unknown> {
  const target = `${path}/${encodeURIComponent(id)}`;
  try {
    return await api.patch<unknown>(target, data);
  } catch {
    return await api.put<unknown>(target, data);
  }
}

export async function deleteRow(api: Api, path: string, id: string): Promise<void> {
  await api.del<unknown>(`${path}/${encodeURIComponent(id)}`);
}
