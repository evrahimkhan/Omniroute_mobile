/**
 * Turning a payload of numbers into something a phone screen can show.
 *
 * Kept apart from the view so it can be tested without a renderer: the analytics
 * routes are the least predictable in the product — a metric may be a number, a
 * duration in milliseconds, a fraction or a currency — and getting that wrong
 * shows a wrong figure, which is worse than showing none.
 */

import { asRecord, scalarFields } from '../api/shape';
import type { Json } from '../api/shape';
import { formatBytes, formatDuration, formatScalar, humanizeKey, isNoiseKey, isSecretKey } from './format';

export interface Breakdown {
  title: string;
  rows: { label: string; value: number; display: string; detail?: string }[];
}

export interface Parsed {
  metrics: { label: string; value: string; hint?: string }[];
  breakdowns: Breakdown[];
  groups: { title: string; values: { label: string; value: string }[] }[];
  lists: { title: string; values: string[] }[];
}

/** Format a number by what its key name says it is. */
function formatByKey(key: string, value: number): string {
  const lower = key.toLowerCase();
  if (/(bytes|memory|size|usage$|rss|heap)/.test(lower)) return formatBytes(value) ?? String(value);
  if (/(ms|latency|duration|elapsed|uptime|window)/.test(lower)) {
    const duration = formatDuration(value);
    if (duration && !/bytes/.test(lower)) return duration;
    return `${Math.round(value)} ms`;
  }
  if (/(rate|ratio|percent|share|p95|p99)/.test(lower) && value <= 1) return `${(value * 100).toFixed(1)}%`;
  if (/(cost|price|spend|usd)/.test(lower)) return `$${value < 1 ? value.toFixed(4) : value.toFixed(2)}`;
  if (value >= 10_000) return value.toLocaleString('en-US');
  return formatScalar(value);
}

function numericValue(record: Json): { key: string; value: number } | null {
  let best: { key: string; value: number } | null = null;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (isNoiseKey(key)) continue;
    if (!best || Math.abs(value) > Math.abs(best.value)) best = { key, value };
  }
  return best;
}

function labelValue(record: Json): string {
  for (const key of ['name', 'label', 'model', 'provider', 'key', 'date', 'bucket', 'hour', 'day', 'tool', 'account', 'id', 'status']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  const firstString = scalarFields(record).find((field) => typeof field.value === 'string');
  return firstString ? String(firstString.value) : 'Entry';
}

export function parseStats(payload: unknown): Parsed {
  const parsed: Parsed = { metrics: [], breakdowns: [], groups: [], lists: [] };
  const record = asRecord(payload);
  if (!record) {
    if (Array.isArray(payload)) parsed.breakdowns = breakdownsFromArray('Entries', payload, parsed);
    return parsed;
  }

  // Metrics first: the scalars a reader scans. Read from the record rather than
  // from scalarFields(), which stringifies — and a stringified "7200000" is not
  // a duration any more.
  for (const [key, value] of Object.entries(record)) {
    if (isNoiseKey(key) || isSecretKey(key)) continue;
    if (typeof value === 'number') {
      parsed.metrics.push({ label: humanizeKey(key), value: formatByKey(key, value) });
    } else if (typeof value === 'boolean') {
      parsed.metrics.push({ label: humanizeKey(key), value: value ? 'yes' : 'no' });
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (isNoiseKey(key)) continue;
    const nested = asRecord(value);
    const list = Array.isArray(value) ? value : null;

    if (list && list.length) {
      const records = list.map((entry) => asRecord(entry)).filter((entry): entry is Json => Boolean(entry));
      if (records.length) {
        breakdownsFromArray(humanizeKey(key), list, parsed);
      } else {
        parsed.lists.push({
          title: humanizeKey(key),
          values: list.slice(0, 40).map((entry) => formatScalar(entry)),
        });
      }
      continue;
    }

    if (nested && !Array.isArray(value)) {
      const values = scalarFields(nested)
        .filter((field) => !isSecretKey(field.key))
        .map((field) => ({ label: humanizeKey(field.key), value: formatScalar(field.value) }));
      if (values.length) parsed.groups.push({ title: humanizeKey(key), values });
      continue;
    }

    if (typeof value === 'string' && !isNoiseKey(key)) {
      // Strings that are not metric-like (URLs, ids, timestamps) read better as
      // a key/value group than as a tile.
      const existing = parsed.groups.find((group) => group.title === 'Details');
      const entry = { label: humanizeKey(key), value: formatScalar(value) };
      if (existing) existing.values.push(entry);
      else parsed.groups.push({ title: 'Details', values: [entry] });
    }
  }

  return parsed;
}

function breakdownsFromArray(title: string, list: unknown[], parsed: Parsed): Breakdown[] {
  const records = list.map((entry) => asRecord(entry)).filter((entry): entry is Json => Boolean(entry));
  if (!records.length) return parsed.breakdowns;

  // The metric is the largest numeric field that is not an id: for usage rows
  // that is requests or tokens, for cost rows it is the amount.
  const totals = new Map<string, number>();
  for (const record of records) {
    const numeric = numericValue(record);
    if (!numeric) continue;
    totals.set(numeric.key, (totals.get(numeric.key) ?? 0) + Math.abs(numeric.value));
  }
  const metricKey = [...totals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!metricKey) return parsed.breakdowns;

  const rows = records
    .map((record) => {
      const value = Number(record[metricKey] ?? 0);
      const detailKeys = Object.keys(record).filter(
        (key) => key !== metricKey && !isNoiseKey(key) && typeof record[key] !== 'object'
      );
      const detail = detailKeys
        .slice(0, 3)
        .map((key) => `${humanizeKey(key)}: ${formatScalar(record[key])}`)
        .join('  ·  ');
      return { label: labelValue(record), value, display: formatByKey(metricKey, value), detail };
    })
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 25);

  const max = Math.max(...rows.map((row) => Math.abs(row.value)), 1);
  const breakdown: Breakdown = {
    title: `${title} — by ${humanizeKey(metricKey)}`,
    rows: rows.map((row) => ({ ...row, ratio: Math.abs(row.value) / max } as Breakdown['rows'][number] & { ratio: number })),
  };
  parsed.breakdowns.push(breakdown);
  return parsed.breakdowns;
}

