/**
 * DeepSeek adapter (OpenAI-format API, https://api-docs.deepseek.com).
 *
 * Model `deepseek-flash` (served by DeepSeek-V4.1-Flash; 1M context, JSON
 * output). Why the OpenAI format and not DeepSeek's Anthropic-compatible
 * endpoint: that endpoint takes only `claude*` model names and supports
 * `output_config.effort` alone, so it cannot do the structured generation
 * `/tutor/generate` needs; the native API has `response_format: json_object`.
 *
 * - Chat (`stream`): thinking is OFF by default — a teacher in class waits for
 *   a short grounded answer, and in thinking mode reasoning tokens count
 *   against `max_tokens`. `reasoning_content` is never shown (it is not the
 *   answer). Configurable.
 * - Generation (`generate`): thinking ON with the configured effort (default
 *   `low` — reasoning is billed as output), JSON object mode; the schema is spelled out in the prompt (the
 *   API guarantees valid JSON, not the schema) and the caller validates every
 *   item again. Empty content (documented as possible) → no data.
 * - finish_reason `content_filter` → refusal; `insufficient_system_resource` /
 *   `aborted` → unavailable. HTTP 401/402/429/5xx → ProviderUnavailable, so the
 *   tutor answers 503 and the client keeps its offline index.
 */
import OpenAI from 'openai';
import { ProviderUnavailable, type GenerateRequest, type GenerateResult, type ProviderChunk, type ProviderRequest, type TutorProvider } from './tutor-provider.js';

export type DeepSeekEffort = 'none' | 'low' | 'high' | 'max';

export interface DeepSeekOptions {
  apiKey: string;
  baseURL?: string;
  model?: string;
  /** Thinking mode for chat answers (default false: fast first token). */
  chatThinking?: boolean;
  /** Reasoning effort for chat when chatThinking is on (default low). */
  chatEffort?: DeepSeekEffort;
  /** Reasoning effort for generation (default `none` = thinking off: reasoning is billed as output). */
  generateEffort?: DeepSeekEffort;
  /** Tests: a fetch stand-in. */
  fetch?: typeof fetch;
}

const CHAT_TIMEOUT_MS = 30_000;
const GENERATE_TIMEOUT_MS = 90_000;
/** Reasoning tokens count against max_tokens in thinking mode: room for them on top of the answer (low effort uses far less). */
const REASONING_HEADROOM = 4_096;

function providerError(err: unknown): ProviderUnavailable {
  if (err instanceof ProviderUnavailable) return err;
  if (err instanceof OpenAI.APIUserAbortError) return new ProviderUnavailable('aborted');
  if (err instanceof OpenAI.APIConnectionTimeoutError) return new ProviderUnavailable('timeout');
  if (err instanceof OpenAI.APIConnectionError) return new ProviderUnavailable('connection');
  if (err instanceof OpenAI.RateLimitError) return new ProviderUnavailable('rate_limited');
  if (err instanceof OpenAI.AuthenticationError) return new ProviderUnavailable('auth');
  if (err instanceof OpenAI.APIError) return new ProviderUnavailable(err.status === 402 ? 'insufficient_balance' : `api_${err.status ?? 'error'}`);
  return new ProviderUnavailable(err instanceof Error ? err.name : 'provider_error');
}

/** DeepSeek-specific request fields (not in the OpenAI SDK types). */
type DeepSeekExtras = { thinking: { type: 'enabled' | 'disabled' }; reasoning_effort?: DeepSeekEffort };
const thinkingFields = (effort: DeepSeekEffort | null): DeepSeekExtras =>
  effort && effort !== 'none' ? { thinking: { type: 'enabled' }, reasoning_effort: effort } : { thinking: { type: 'disabled' } };

interface DeepSeekUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** Context caching on disk: the part of the prompt served from cache (billed at the cache-hit price). */
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}
const toUsage = (u: DeepSeekUsage | undefined) => ({ inputTokens: u?.prompt_tokens ?? 0, outputTokens: u?.completion_tokens ?? 0, cachedInputTokens: u?.prompt_cache_hit_tokens ?? 0 });

export class DeepSeekProvider implements TutorProvider {
  readonly name = 'deepseek';
  readonly model: string;
  private client: OpenAI;
  private chatEffort: DeepSeekEffort | null;
  private generateEffort: DeepSeekEffort;

  constructor(o: DeepSeekOptions) {
    this.model = o.model ?? 'deepseek-flash';
    this.chatEffort = o.chatThinking ? (o.chatEffort ?? 'low') : null;
    this.generateEffort = o.generateEffort ?? 'none';
    // maxRetries 1: a failed call falls back to the client's offline index quickly.
    this.client = new OpenAI({ apiKey: o.apiKey, baseURL: o.baseURL ?? 'https://api.deepseek.com', maxRetries: 1, ...(o.fetch ? { fetch: o.fetch } : {}) });
  }

  /** An admin model setting is honoured when it names a DeepSeek model; otherwise ours (failover). */
  private modelFor(requested: string): string {
    return requested.startsWith('deepseek') ? requested : this.model;
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderChunk> {
    try {
      const extras = thinkingFields(this.chatEffort);
      const stream = await this.client.chat.completions.create(
        {
          model: this.modelFor(req.model),
          messages: [{ role: 'system', content: req.system }, ...req.messages.map((m) => ({ role: m.role, content: m.text }))],
          max_tokens: req.maxTokens + (this.chatEffort ? REASONING_HEADROOM : 0),
          stream: true,
          stream_options: { include_usage: true },
          ...extras,
        } as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
        { signal: req.signal, timeout: CHAT_TIMEOUT_MS },
      );
      let usage: DeepSeekUsage | undefined;
      let finish: string | null = null;
      for await (const chunk of stream) {
        if (chunk.usage) usage = chunk.usage as DeepSeekUsage;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        // `reasoning_content` deltas are the model's scratchpad, not the answer: skipped.
        const text = choice.delta?.content;
        if (text) yield { type: 'text', text };
        if (choice.finish_reason) finish = choice.finish_reason as string;
      }
      if (finish === 'insufficient_system_resource' || finish === 'aborted') throw new ProviderUnavailable(`finish_${finish}`);
      if (finish === 'content_filter') yield { type: 'refusal' };
      yield { type: 'usage', ...toUsage(usage) };
    } catch (err) {
      throw providerError(err);
    }
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    try {
      const extras = thinkingFields(this.generateEffort);
      const completion = await this.client.chat.completions.create(
        {
          model: this.modelFor(req.model),
          messages: [
            { role: 'system', content: req.system },
            {
              role: 'user',
              // JSON mode needs the word «json» and the expected shape in the prompt.
              content: `${req.prompt}\n\nReply with one json object only, matching this JSON Schema exactly:\n${JSON.stringify(req.schema)}`,
            },
          ],
          max_tokens: req.maxTokens + (this.generateEffort !== 'none' ? REASONING_HEADROOM : 0),
          response_format: { type: 'json_object' },
          ...extras,
        } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
        { signal: req.signal, timeout: GENERATE_TIMEOUT_MS },
      );
      const u = completion.usage as DeepSeekUsage | undefined;
      const usage = toUsage(u);
      const choice = completion.choices[0];
      const finish = choice?.finish_reason as string | undefined;
      if (finish === 'insufficient_system_resource' || finish === 'aborted') throw new ProviderUnavailable(`finish_${finish}`);
      const text = choice?.message?.content ?? '';
      if (finish === 'content_filter' || finish === 'length' || !text.trim()) return { data: null, usage };
      try {
        return { data: JSON.parse(text), usage };
      } catch {
        return { data: null, usage };
      }
    } catch (err) {
      throw providerError(err);
    }
  }
}

/**
 * Failover: answers with `primary`; when it is unavailable (outage, rate
 * limit, balance, auth) BEFORE any text was sent, the same request goes to
 * `secondary`. A failure after text was streamed is not retried (the teacher
 * already sees half an answer).
 */
export class FallbackProvider implements TutorProvider {
  readonly name: string;
  constructor(
    private primary: TutorProvider,
    private secondary: TutorProvider,
    private onFallback: (from: string, to: string, reason: string) => void = () => {},
  ) {
    this.name = `${primary.name}+${secondary.name}`;
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderChunk> {
    let sent = false;
    try {
      for await (const c of this.primary.stream(req)) {
        if (c.type === 'text') sent = true;
        yield c;
      }
      return;
    } catch (err) {
      if (sent || !(err instanceof ProviderUnavailable) || err.message === 'aborted') throw err;
      this.onFallback(this.primary.name, this.secondary.name, err.message);
    }
    yield* this.secondary.stream(req);
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    try {
      return await this.primary.generate(req);
    } catch (err) {
      if (!(err instanceof ProviderUnavailable) || err.message === 'aborted') throw err;
      this.onFallback(this.primary.name, this.secondary.name, err.message);
      return this.secondary.generate(req);
    }
  }
}
