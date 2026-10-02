/**
 * Settings-shaped surfaces: read an object, edit it with native controls, write
 * back the changed keys.
 *
 * This is the piece that makes "every dashboard function" tractable. The
 * dashboard's settings pages are a client component that fetches one object and
 * PATCHes parts of it back — the same shape dozens of times over. Reading that
 * object's own metadata is what lets the app draw real switches and pickers
 * instead of dumping JSON: several routes (feature flags, compression engines,
 * cache config) return a self-describing list of `{key, label, type,
 * enumValues, effectiveValue, requiresRestart}` entries, which *is* a form spec.
 *
 * When there is no metadata, fields are inferred from the payload and labelled
 * from their keys. Unknown shapes degrade to read-only rather than guessing at a
 * write the gateway would reject.
 */

import type { Api } from './client';
import { asArray, asRecord, bool, pickStr, type Json } from './shape';
import { humanizeKey, isSecretKey } from '../screens/format';

export type ConfigFieldType = 'boolean' | 'number' | 'string' | 'long' | 'secret' | 'enum';

export interface ConfigField {
  /** Dotted path inside the payload, e.g. `cache.ttlSeconds`. */
  key: string;
  label: string;
  description?: string;
  type: ConfigFieldType;
  value: unknown;
  options?: string[];
  requiresRestart?: boolean;
  /** Where the effective value comes from: "db", "env", "default". */
  source?: string;
  /** The gateway reports it, but editing it is not this screen's job. */
  readOnly?: boolean;
}

export interface ConfigGroup {
  title: string;
  fields: ConfigField[];
}

export async function readConfig(api: Api, path: string): Promise<unknown> {
  return api.get<unknown>(path);
}

/**
 * Write the changed keys back.
 *
 * Only what the user touched is sent: these routes merge partial objects, and
 * echoing the whole payload back would make the app responsible for every field
 * it never displayed.
 */
export async function saveConfig(
  api: Api,
  path: string,
  changes: Record<string, unknown>,
  method: 'patch' | 'post' | 'put' = 'patch'
): Promise<unknown> {
  // Nesting happens here rather than at the call site: a caller that forgets
  // would POST `{"cache.ttlSeconds": 60}`, which the route accepts and ignores,
  // and the setting would silently not change.
  const body = nestChanges(changes);
  if (method === 'post') return api.post<unknown>(path, body);
  if (method === 'put') return api.put<unknown>(path, body);
  return api.patch<unknown>(path, body);
}

/** Rebuild nested objects from dotted paths: `{ 'cache.ttl': 5 }` → `{cache:{ttl:5}}`. */
export function nestChanges(changes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) {
    const parts = key.split('.');
    let cursor = out;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      const next = asRecord(cursor[part]);
      if (next) cursor[part] = next;
      else cursor[part] = {};
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1]] = value;
  }
  return out;
}

const BOOLEAN_STRINGS = new Set(['true', 'false', 'yes', 'no', 'on', 'off', 'enabled', 'disabled', '1', '0']);

function coerceBoolean(value: unknown): boolean | undefined {
  const direct = bool(value);
  if (direct !== undefined) return direct;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (['true', 'yes', 'on', 'enabled', '1'].includes(lower)) return true;
    if (['false', 'no', 'off', 'disabled', '0'].includes(lower)) return false;
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Json {
  return Boolean(asRecord(value));
}

/**
 * Fields described by the payload itself.
 *
 * Recognised by shape rather than by route: an array of objects that carry a
 * `key` plus a current value and (usually) a label. `enumValues` becomes a
 * picker, `requiresRestart` a note next to the switch.
 */
function fieldsFromMetadata(payload: Json): { groups: ConfigGroup[]; consumed: string[] } {
  // An entry counts as configuration when it names itself and carries a current
  // value. Routes spell that value `value`, `effectiveValue` or `currentValue`
  // depending on the page, so all three are accepted; an array that matches none
  // of them is data — a list of providers or models — and is left alone.
  const isFieldEntry = (entry: Json) =>
    typeof entry.key === 'string' && ('value' in entry || 'effectiveValue' in entry || 'currentValue' in entry);

  const arrays: { key: string; title: string; items: Json[] }[] = [];
  for (const [key, value] of Object.entries(payload)) {
    const list = asArray(value).filter(isPlainObject);
    if (list.length && list.every(isFieldEntry)) arrays.push({ key, title: humanizeKey(key), items: list });
  }
  if (!arrays.length) return { groups: [], consumed: [] };

  const groups = arrays.map(({ title, items }) => ({
    title,
    fields: items.map((entry) => {
      const key = String(entry.key);
      const raw = 'effectiveValue' in entry ? entry.effectiveValue : 'value' in entry ? entry.value : entry.currentValue;
      const declared = pickStr(entry, 'type')?.toLowerCase();
      const options = asArray(entry.enumValues)
        .map((option) => (typeof option === 'string' ? option : pickStr(asRecord(option), 'value', 'label')))
        .filter((option): option is string => Boolean(option));

      let type: ConfigFieldType;
      if (declared === 'boolean' || typeof coerceBoolean(raw) === 'boolean') type = 'boolean';
      else if (options.length) type = 'enum';
      else if (typeof raw === 'number') type = 'number';
      else if (typeof raw === 'string' && raw.length > 60) type = 'long';
      else type = 'string';
      if (isSecretKey(key)) type = 'secret';

      const category = pickStr(entry, 'category');
      return {
        key,
        label: pickStr(entry, 'label', 'name') ?? humanizeKey(key),
        description: pickStr(entry, 'description', 'help', 'hint'),
        type,
        value: type === 'boolean' ? coerceBoolean(raw) : raw,
        options: options.length ? options : undefined,
        requiresRestart: coerceBoolean(entry.requiresRestart),
        source: pickStr(entry, 'source', 'origin'),
        readOnly: coerceBoolean(entry.readOnly) === true,
        category: category ?? title,
      } as ConfigField & { category?: string };
    }),
  }));

  return { groups, consumed: arrays.map((array) => array.key) };
}

/**
 * Fields inferred from a plain settings object, one level deep.
 *
 * Only primitives become editable inputs. Nested objects are flattened one level
 * because that is how the dashboard's settings are shaped (`cache: {enabled}`),
 * and anything deeper — arrays of rules, provider trees — is left to the
 * read-only view, where a wrong write cannot happen.
 */
function fieldsFromObject(payload: Json, skip: Set<string> = new Set()): ConfigGroup[] {
  const groups = new Map<string, ConfigField[]>();

  const add = (group: string, key: string, value: unknown) => {
    const list = groups.get(group) ?? [];
    if (isSecretKey(key)) {
      list.push({ key, label: humanizeKey(key.split('.').pop() ?? key), type: 'secret', value, readOnly: true });
    } else if (typeof value === 'boolean') {
      list.push({ key, label: humanizeKey(key.split('.').pop() ?? key), type: 'boolean', value });
    } else if (typeof value === 'number') {
      list.push({ key, label: humanizeKey(key.split('.').pop() ?? key), type: 'number', value });
    } else if (typeof value === 'string') {
      if (!value) return;
      list.push({
        key,
        label: humanizeKey(key.split('.').pop() ?? key),
        type: value.length > 60 ? 'long' : 'string',
        value,
      });
    } else {
      return; // objects, arrays and nulls are not editable here
    }
    groups.set(group, list);
  };

  for (const [key, value] of Object.entries(payload)) {
    if (skip.has(key)) continue;
    if (isPlainObject(value)) {
      for (const [childKey, childValue] of Object.entries(value)) add(key, `${key}.${childKey}`, childValue);
    } else {
      add('Settings', key, value);
    }
  }

  return [...groups.entries()]
    .filter(([, fields]) => fields.length > 0)
    .map(([title, fields]) => ({ title: title === 'Settings' ? 'Settings' : humanizeKey(title), fields }));
}

/** The groups a config surface should draw, best source first. */
export function configGroups(payload: unknown): ConfigGroup[] {
  const record = asRecord(payload);
  if (!record) {
    if (Array.isArray(payload)) return [];
    return [];
  }
  const metadata = fieldsFromMetadata(record);
  if (!metadata.groups.length) return fieldsFromObject(record);

  // Metadata fields carry a `category`; regroup them by it so the screen shows
  // the dashboard's own sections rather than one long list.
  const byCategory = new Map<string, ConfigField[]>();
  for (const group of metadata.groups) {
    for (const field of group.fields) {
      const category = (field as ConfigField & { category?: string }).category ?? group.title;
      const list = byCategory.get(category) ?? [];
      list.push(field);
      byCategory.set(category, list);
    }
  }

  // A settings payload usually holds both: the described flags *and* plain
  // settings beside them. Showing only the flags would hide half the page.
  const groups: ConfigGroup[] = [...byCategory.entries()].map(([title, fields]) => ({ title, fields }));
  for (const group of fieldsFromObject(record, new Set(metadata.consumed))) groups.push(group);

  const seen = new Set<string>();
  return groups.filter((group) => (seen.has(group.title) ? false : seen.add(group.title)));
}

/** How many fields in a payload are editable — used to pick a renderer. */
export function countEditable(groups: ConfigGroup[]): number {
  return groups.reduce((total, group) => total + group.fields.filter((field) => !field.readOnly).length, 0);
}
