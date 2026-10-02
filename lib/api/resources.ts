/**
 * The gateway resources the app's screens are built on.
 *
 * One function per surface, each returning a *view model* rather than the
 * gateway's raw JSON. The mapping is tolerant on purpose (see `shape.ts`): the
 * gateway's routes are written for its own dashboard and their field names differ
 * between surfaces, so the normalisers accept the plausible spellings and report
 * "not reported" rather than a confident wrong value. Each view model keeps the
 * raw record, so a detail sheet can show what was actually returned.
 *
 * Endpoint paths are the upstream ones, taken from the route list of the pinned
 * ref — `/api/providers`, `/api/models`, `/api/keys`, `/api/combos`,
 * `/api/usage/call-logs`, `/api/telemetry/summary`.
 */

import type { Api } from './client';
import {
  asArray,
  asRecord,
  compactNumber,
  pick,
  pickBool,
  pickNum,
  pickStr,
  relativeTime,
  str,
  titleCase,
  type Json,
} from './shape';

// ---------------------------------------------------------------- health

export interface GatewayHealth {
  ok: boolean;
  status: string;
  at: string;
  detail?: string;
}

export async function getHealth(api: Api): Promise<GatewayHealth> {
  const raw = asRecord(await api.get<unknown>('/api/health'));
  const status = pickStr(raw, 'status') || 'unknown';
  return {
    ok: status === 'ok' || status === 'healthy' || status === 'up',
    status,
    at: pickStr(raw, 'timestamp', 'time', 'at'),
  };
}

export interface Telemetry {
  uptimeMs?: number;
  memoryBytes?: number;
  activeConnections?: number;
  errorRate?: number;
  raw: Json | null;
}

export async function getTelemetry(api: Api, windowMs = 3_600_000): Promise<Telemetry> {
  const raw = asRecord(await api.get<unknown>('/api/telemetry/summary', { query: { windowMs } }));
  const memory = pickNum(raw, 'memoryUsage', 'memory', 'rss');
  return {
    uptimeMs: pickNum(raw, 'uptime', 'uptimeMs'),
    memoryBytes: memory,
    activeConnections: pickNum(raw, 'activeConnections', 'connections'),
    errorRate: pickNum(raw, 'errorRate', 'error_rate'),
    raw,
  };
}

// ------------------------------------------------------------- providers

export interface Provider {
  id: string;
  name: string;
  provider: string;
  /** The gateway's own "is this connection usable" flag, when it says. */
  active?: boolean;
  models?: number;
  detail?: string;
  raw: Json;
}

/**
 * Provider connections, active or not.
 *
 * `/api/providers` answers `{connections, safeConnections}`: the first has the
 * credentials, the second is redacted for display. This uses `safeConnections`
 * when it is there — a native app has no reason to hold a provider's key in
 * memory to render a list — and falls back to `connections` for older builds.
 */
export function normalizeProviders(payload: unknown): Provider[] {
  const root = asRecord(payload);
  const candidates = [
    ...asArray(root?.safeConnections ?? [], 'items', 'data'),
    ...asArray(root?.connections ?? [], 'items', 'data'),
  ];
  const seen = new Set<string>();
  const providers: Provider[] = [];
  for (const item of candidates) {
    const raw = asRecord(item);
    if (!raw) continue;
    const id = pickStr(raw, 'id', 'connectionId', 'connection_id') || `p${providers.length}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const provider = pickStr(raw, 'provider', 'providerId', 'provider_id', 'slug') || 'unknown';
    const models = pickNum(raw, 'modelCount', 'modelsCount', 'models');
    providers.push({
      id,
      name: pickStr(raw, 'name', 'label', 'displayName') || titleCase(provider),
      provider,
      active: pickBool(raw, 'isActive', 'active', 'enabled', 'isEnabled'),
      models: typeof models === 'number' ? models : undefined,
      detail: pickStr(raw, 'accountLabel', 'email', 'account', 'status'),
      raw,
    });
  }
  return providers;
}

export async function getProviders(api: Api, query: { limit?: number; offset?: number; provider?: string } = {}) {
  return normalizeProviders(await api.get<unknown>('/api/providers', { query }));
}

/** Turn one or more connections on or off. */
export async function setProvidersActive(api: Api, ids: string[], isActive: boolean) {
  const result = asRecord(await api.patch<unknown>('/api/providers', { ids, isActive }));
  return {
    updated: pickNum(result, 'updated') ?? 0,
    notFound: asArray(result?.notFound).map((v) => str(v)),
  };
}

// ---------------------------------------------------------------- models

export interface ModelEntry {
  id: string;
  name: string;
  provider: string;
  /** True when the gateway says a connection for it exists. */
  configured?: boolean;
  contextLength?: number;
  raw: Json;
}

/**
 * The model catalog.
 *
 * `/api/models?all=true` returns every model the build knows; without `all` it
 * returns only those whose provider is configured. The app asks for all of them
 * and labels the configured ones, because "this model exists but you have not
 * connected its provider" is the more useful sentence on a phone.
 */
export function normalizeModels(payload: unknown): ModelEntry[] {
  const root = asRecord(payload);
  const list = asArray(root?.models ?? payload, 'items', 'data', 'catalog');
  const models: ModelEntry[] = [];
  for (const item of list) {
    if (typeof item === 'string') {
      // A bare id is often namespaced `provider/model`; take the provider from
      // it rather than leaving the filter with nothing to group by.
      models.push({
        id: item,
        name: item.includes('/') ? item.split('/').slice(1).join('/') : item,
        provider: item.includes('/') ? item.split('/')[0] : '',
        raw: {},
      });
      continue;
    }
    const raw = asRecord(item);
    if (!raw) continue;
    // A model id is often namespaced `provider/model`; the provider may also be
    // its own field, and the two do not always agree.
    const id = pickStr(raw, 'id', 'model', 'modelId', 'name', 'slug');
    if (!id) continue;
    const provider =
      pickStr(raw, 'provider', 'providerId', 'provider_id', 'owned_by') ||
      (id.includes('/') ? id.split('/')[0] : '');
    const context = pickNum(raw, 'contextLength', 'context_length', 'contextWindow', 'maxTokens');
    models.push({
      id,
      name: pickStr(raw, 'displayName', 'label', 'name') || (id.includes('/') ? id.split('/').slice(1).join('/') : id),
      provider,
      configured: pickBool(raw, 'configured', 'available', 'isConfigured', 'active'),
      contextLength: context,
      raw,
    });
  }
  return models;
}

export async function getModels(api: Api, options: { all?: boolean } = {}) {
  return normalizeModels(await api.get<unknown>('/api/models', { query: { all: options.all ?? true } }));
}

// ------------------------------------------------------------------ keys

export interface ApiKey {
  id: string;
  name: string;
  /** The secret, when the gateway shows it (create/reveal only). */
  secret?: string;
  hint?: string;
  createdAt?: string;
  lastUsedAt?: string;
  requests?: number;
  raw: Json;
}

/** A value that could actually be pasted into a client, rather than a mask. */
function isFullKey(value: string): boolean {
  if (value.length < 16) return false;
  if (/[…*]|\.\.\./.test(value)) return false;
  return true;
}

export function normalizeKeys(payload: unknown): { keys: ApiKey[]; allowReveal: boolean } {
  const root = asRecord(payload);
  const list = asArray(root?.keys ?? payload, 'items', 'data');
  const keys: ApiKey[] = [];
  for (const item of list) {
    const raw = asRecord(item);
    if (!raw) continue;
    const id = pickStr(raw, 'id', 'keyId', 'key_id');
    const secret = pickStr(raw, 'key', 'secret', 'token', 'value');
    keys.push({
      id: id || secret || `k${keys.length}`,
      name: pickStr(raw, 'name', 'label') || (id ? `Key ${id.slice(0, 6)}` : 'API key'),
      // A *complete* key is worth offering to copy; a masked one is not. The
      // list route redacts by default and only returns the value when reveal is
      // allowed, so the app must tell "here is your key" from "here is where it
      // would be" — an ellipsis or a run of asterisks is not a key.
      secret: isFullKey(secret) ? secret : undefined,
      hint: pickStr(raw, 'hint', 'prefix', 'masked', 'keyPreview') || (secret ? `${secret.slice(0, 8)}…` : ''),
      createdAt: pickStr(raw, 'createdAt', 'created_at', 'created'),
      lastUsedAt: pickStr(raw, 'lastUsedAt', 'last_used_at', 'lastUsed'),
      requests: pickNum(raw, 'requests', 'requestCount', 'usageCount'),
      raw,
    });
  }
  return { keys, allowReveal: pickBool(root, 'allowKeyReveal') ?? false };
}

export async function getKeys(api: Api, query: { limit?: number; offset?: number } = {}) {
  return normalizeKeys(await api.get<unknown>('/api/keys', { query }));
}

export async function createKey(api: Api, input: { name?: string; modelAccessMode?: string }) {
  const payload = await api.post<unknown>('/api/keys', {
    name: input.name || 'Mobile key',
    ...(input.modelAccessMode ? { modelAccessMode: input.modelAccessMode } : {}),
  });
  const { keys } = normalizeKeys(payload);
  const root = asRecord(payload);
  const created =
    keys[0] ??
    (() => {
      const record = asRecord(pick(root, 'key'));
      if (!record) return null;
      return normalizeKeys({ keys: [record] }).keys[0] ?? null;
    })();
  return created;
}

export async function deleteKey(api: Api, id: string) {
  await api.del<unknown>(`/api/keys/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------- combos

export interface Combo {
  id: string;
  name: string;
  description?: string;
  members: string[];
  active?: boolean;
  raw: Json;
}

export function normalizeCombos(payload: unknown): Combo[] {
  const root = asRecord(payload);
  const combos: Combo[] = [];
  for (const item of asArray(root?.combos ?? payload, 'items', 'data')) {
    const raw = asRecord(item);
    if (!raw) continue;
    const members = asArray(pick(raw, 'models', 'members', 'providers', 'steps'))
      .map((entry) => (typeof entry === 'string' ? entry : pickStr(asRecord(entry), 'model', 'name', 'provider')))
      .filter(Boolean);
    combos.push({
      id: pickStr(raw, 'id', 'comboId', 'name') || `combo-${combos.length}`,
      name: pickStr(raw, 'name', 'label', 'id') || 'Combo',
      description: pickStr(raw, 'description', 'notes', 'strategy') || undefined,
      members,
      active: pickBool(raw, 'isActive', 'active', 'enabled'),
      raw,
    });
  }
  return combos;
}

export async function getCombos(api: Api, query: { limit?: number; offset?: number } = {}) {
  return normalizeCombos(await api.get<unknown>('/api/combos', { query }));
}

// ------------------------------------------------------------- call logs

export interface CallLog {
  id: string;
  at: string;
  when: string;
  model: string;
  provider: string;
  status: string;
  ok: boolean;
  latencyMs?: number;
  tokens?: number;
  cost?: number;
  keyName?: string;
  raw: Json;
}

export function normalizeCallLogs(payload: unknown): CallLog[] {
  const root = asRecord(payload);
  const logs: CallLog[] = [];
  for (const item of asArray(root?.logs ?? root?.callLogs ?? payload, 'items', 'data', 'entries')) {
    const raw = asRecord(item);
    if (!raw) continue;
    const status = pickStr(raw, 'status', 'outcome', 'state', 'statusCode');
    const code = pickNum(raw, 'statusCode', 'status_code', 'httpStatus');
    const ok =
      pickBool(raw, 'ok', 'success') ??
      (code !== undefined ? code < 400 : /^(ok|success|200|completed|done)$/i.test(status));
    const at = pickStr(raw, 'timestamp', 'createdAt', 'time', 'at', 'date');
    logs.push({
      id: pickStr(raw, 'id', 'requestId', 'correlationId') || `log-${logs.length}`,
      at,
      when: relativeTime(at || pick(raw, 'timestamp', 'time')),
      model: pickStr(raw, 'model', 'modelId', 'modelName') || '—',
      provider: pickStr(raw, 'provider', 'providerId', 'connection') || '—',
      status: status || (code !== undefined ? String(code) : ok ? 'ok' : 'error'),
      ok,
      latencyMs: pickNum(raw, 'latencyMs', 'latency', 'durationMs', 'duration', 'ms'),
      tokens: pickNum(raw, 'totalTokens', 'tokens', 'usage'),
      cost: pickNum(raw, 'cost', 'costUsd', 'price'),
      keyName: pickStr(raw, 'apiKeyName', 'keyName', 'key') || undefined,
      raw,
    });
  }
  return logs;
}

export async function getCallLogs(
  api: Api,
  query: { limit?: number; offset?: number; search?: string; status?: string; model?: string; provider?: string } = {}
) {
  return normalizeCallLogs(await api.get<unknown>('/api/usage/call-logs', { query }));
}

/** A one-line summary for a list row: latency, tokens, cost — whichever exist. */
export function logSummary(log: CallLog): string {
  const parts: string[] = [];
  if (log.latencyMs !== undefined) parts.push(`${Math.round(log.latencyMs)} ms`);
  if (log.tokens !== undefined) parts.push(`${compactNumber(log.tokens)} tok`);
  if (log.cost !== undefined) parts.push(`$${log.cost.toFixed(4)}`);
  if (log.keyName) parts.push(log.keyName);
  return parts.join(' · ');
}
