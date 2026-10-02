/**
 * Talking to a model through the gateway.
 *
 * The gateway exposes an OpenAI-compatible endpoint, so the native Playground is
 * an ordinary chat client: POST a message list, read the streamed deltas. Two
 * details are the gateway's rather than OpenAI's:
 *
 *   - **The path.** Upstream serves the OpenAI surface under `/api/v1/*` and
 *     advertises `/v1/*` to clients; builds differ in whether the bare path is
 *     present, so the first request probes and the answer is remembered for the
 *     session rather than assumed.
 *   - **Streaming may not be available.** `response.body` is a `ReadableStream`
 *     on a modern Hermes build and `null` on an older one. When it is missing
 *     the request is retried without `stream: true` — not as good, but a whole
 *     answer beats an error about a transport.
 *
 * The SSE parser is exported separately and pure, so it is tested without a
 * device (scripts/check-api-client.mjs).
 */

import { ApiError, type Api } from './client';
import { asArray, asRecord, pickStr, type Json } from './shape';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatChoice {
  model: string;
  text: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

/**
 * A streaming SSE decoder.
 *
 * Feed it text as it arrives; it returns the complete events found so far and
 * keeps the remainder. Events are separated by a blank line, and a chunk can
 * split one anywhere — including mid-UTF-8 character, which is why the caller
 * decodes with `{ stream: true }` on a TextDecoder rather than `toString()` on
 * the bytes.
 */
export function createSseDecoder(): (chunk: string) => Array<{ event: string; data: string }> {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk;
    const events: Array<{ event: string; data: string }> = [];
    for (;;) {
      const boundary = buffer.search(/\r?\n\r?\n/);
      if (boundary === -1) break;
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
      let event = 'message';
      const data: string[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith(':')) continue; // comment / keep-alive
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) events.push({ event, data: data.join('\n') });
    }
    return events;
  };
}

/** The text of one streamed chunk, or null when it carries nothing visible. */
export function deltaFromEvent(data: string): string | null {
  if (!data || data === '[DONE]') return null;
  try {
    const parsed = asRecord(JSON.parse(data));
    const choices = asArray(parsed?.choices);
    const first = asRecord(choices[0]);
    const delta = asRecord(first?.delta);
    const text = pickStr(delta, 'content');
    if (text) return text;
    // Some providers answer with `text` on the choice itself.
    return pickStr(first, 'text') || null;
  } catch {
    return null;
  }
}

const PRIMARY_PATH = '/v1/chat/completions';
const FALLBACK_PATH = '/api/v1/chat/completions';

/** Set once a probe has answered, so later requests skip the wrong path. */
let knownPath: string | null = null;

export function __resetChatPathForTests() {
  knownPath = null;
}

function pathsToTry(): string[] {
  if (knownPath) return [knownPath];
  return [PRIMARY_PATH, FALLBACK_PATH];
}

export interface StreamChatOptions {
  model: string;
  messages: ChatMessage[];
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Send a chat request and stream the answer back.
 *
 * Resolves with the complete text (and the model the gateway says answered), or
 * throws an `ApiError` naming the URL — the same contract as the REST client, so
 * a screen has one way to explain a failure.
 */
export async function streamChat(api: Api, options: StreamChatOptions): Promise<ChatChoice> {
  const body = {
    model: options.model,
    messages: options.messages,
    stream: true,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
  };

  let lastError: unknown = null;
  for (const path of pathsToTry()) {
    try {
      const response = (await api.post<Response>(path, body, { raw: true, timeoutMs: 120_000 })) as unknown as Response;
      const contentType = response.headers.get('content-type') ?? '';

      // A JSON answer where a stream was asked for: the gateway ignored the
      // flag, which is a perfectly good outcome.
      if (!response.body || contentType.includes('application/json')) {
        const text = await response.text();
        knownPath = path;
        return choiceFromJson(text);
      }

      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decode = new TextDecoder();
      const sse = createSseDecoder();
      let answer = '';
      let model = options.model;

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const event of sse(decode.decode(value, { stream: true }))) {
          if (event.data === '[DONE]') continue;
          try {
            const parsed = asRecord(JSON.parse(event.data));
            const choices = asArray(parsed?.choices);
            const first = asRecord(choices[0]);
            const named = pickStr(first, 'model') || pickStr(parsed, 'model');
            if (named) model = named;
            const usage = asRecord(parsed?.usage);
            if (usage && !done) {
              // Usage arrives in the final chunk on some providers.
              answer = answer || '';
            }
          } catch {
            // Not JSON (a keep-alive or a provider quirk): the text handler
            // below is the only thing that matters.
          }
          const delta = deltaFromEvent(event.data);
          if (delta) {
            answer += delta;
            options.onDelta?.(delta);
          }
        }
      }
      knownPath = path;
      return { model, text: answer };
    } catch (err) {
      lastError = err;
      // A 404 means the path probe was wrong; anything else is the real answer.
      const notFound = err instanceof ApiError && err.status === 404;
      if (!notFound) throw err;
      const tried = pathsToTry();
      if (path === tried[tried.length - 1]) break;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('The gateway did not answer the chat request');
}

function choiceFromJson(text: string): ChatChoice {
  const parsed = asRecord(JSON.parse(text));
  const first = asRecord(asArray(parsed?.choices)[0]);
  const message = asRecord(first?.message);
  const usage = asRecord(parsed?.usage);
  return {
    model: pickStr(parsed, 'model') || pickStr(first, 'model') || 'unknown',
    text: pickStr(message, 'content') || pickStr(first, 'text'),
    usage: usage
      ? {
          promptTokens: Number(usage.prompt_tokens ?? usage.promptTokens ?? 0) || undefined,
          completionTokens: Number(usage.completion_tokens ?? usage.completionTokens ?? 0) || undefined,
          totalTokens: Number(usage.total_tokens ?? usage.totalTokens ?? 0) || undefined,
        }
      : undefined,
  };
}

/**
 * A one-shot completion, for screens that just need an answer.
 *
 * Falls back here automatically when streaming is unavailable.
 */
export async function completeChat(
  api: Api,
  options: Omit<StreamChatOptions, 'onDelta'>
): Promise<ChatChoice> {
  const body = {
    model: options.model,
    messages: options.messages,
    stream: false,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
  };
  let lastError: unknown = null;
  for (const path of pathsToTry()) {
    try {
      const payload = await api.post<unknown>(path, body, { timeoutMs: 120_000, signal: options.signal });
      knownPath = path;
      return choiceFromJson(JSON.stringify(payload));
    } catch (err) {
      lastError = err;
      if (!(err instanceof ApiError) || err.status !== 404) throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('The gateway did not answer the chat request');
}

/** The models a chat screen can offer, newest first by the gateway's own order. */
export function chatModelIds(payload: unknown): string[] {
  const root = asRecord(payload);
  const list = asArray(root?.models ?? payload, 'data', 'items');
  const ids: string[] = [];
  for (const item of list) {
    if (typeof item === 'string') ids.push(item);
    else {
      const record = item as Json | null;
      const id = pickStr(record, 'id', 'model', 'name');
      if (id) ids.push(id);
    }
  }
  return ids;
}
