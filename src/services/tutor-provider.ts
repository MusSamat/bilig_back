/**
 * LLM provider adapter (TZ §7 «Адаптер к LLM-провайдеру»): the tutor talks to
 * this interface only, so the provider can change without touching the
 * route. The Anthropic adapter streams Claude (`claude-opus-5-5` by default).
 */
import Anthropic from '@anthropic-ai/sdk';
import type { AssistIntent, ContentPackage, Lang } from '@bilig/content-model';

export interface ProviderMessage {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * The structured facts behind a request. A model provider ignores it (the
 * system prompt already carries the material); the `dev` provider answers
 * from it directly, so the whole pipeline runs without an LLM.
 */
export interface ProviderGrounding {
  pkg: ContentPackage;
  lang: Lang;
  conceptKey?: string;
  question?: string;
  quote?: string;
  intent?: AssistIntent;
}

export interface ProviderRequest {
  model: string;
  system: string;
  messages: ProviderMessage[];
  maxTokens: number;
  signal?: AbortSignal;
  grounding?: ProviderGrounding;
}

/** Structured generation («Ещё примеры» / «Ещё вопросы»): JSON matching `schema`. */
export interface GenerateRequest {
  model: string;
  system: string;
  prompt: string;
  /** JSON Schema of the output (structured outputs). */
  schema: Record<string, unknown>;
  maxTokens: number;
  signal?: AbortSignal;
  grounding?: ProviderGrounding & { kind: 'simple' | 'stem' | 'quiz'; count: number; avoid: string[] };
  /** v0.9.2: page images sent with the prompt (data URLs, JPEG / PNG / WebP) — reading a book's contents. */
  images?: string[];
}

/** `data:image/jpeg;base64,…` → its media type and base64 body. */
export function parseDataUrl(url: string): { mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'; data: string } | null {
  const m = url.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/);
  return m ? { mediaType: m[1] as 'image/jpeg', data: m[2].replace(/\s+/g, '') } : null;
}

export interface GenerateResult {
  /** Parsed JSON (validated again by the caller), or null when the model declined. */
  data: unknown;
  usage: ProviderUsage;
}

/** Tokens of one model call. `cachedInputTokens` (part of `inputTokens`) were a provider prompt-cache hit — billed far lower. */
export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export type ProviderChunk =
  | { type: 'text'; text: string }
  | ({ type: 'usage' } & ProviderUsage)
  /** The model (or its safety layer) declined; the route answers with a polite refusal. */
  | { type: 'refusal' };

export interface TutorProvider {
  readonly name: string;
  stream(req: ProviderRequest): AsyncIterable<ProviderChunk>;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

export class ProviderUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ProviderUnavailable';
  }
}

const TIMEOUT_MS = 20_000;

function providerError(err: unknown): ProviderUnavailable {
  if (err instanceof ProviderUnavailable) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new ProviderUnavailable('aborted');
  if (err instanceof Anthropic.RateLimitError) return new ProviderUnavailable('rate_limited');
  if (err instanceof Anthropic.AuthenticationError) return new ProviderUnavailable('auth');
  if (err instanceof Anthropic.APIError) return new ProviderUnavailable(`api_${err.status ?? 'error'}`);
  return new ProviderUnavailable(err instanceof Error ? err.name : 'provider_error');
}

export class AnthropicProvider implements TutorProvider {
  readonly name = 'anthropic';
  private client: Anthropic;

  /** `model`: used when the request names a non-Claude model (a setting meant for another provider, or failover). */
  constructor(apiKey: string, private readonly model = 'claude-opus-5-5') {
    // maxRetries 1: a failed call falls back to the client's offline index quickly.
    this.client = new Anthropic({ apiKey, maxRetries: 1, timeout: TIMEOUT_MS });
  }

  private modelFor(requested: string): string {
    return requested.startsWith('claude') ? requested : this.model;
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderChunk> {
    let stream;
    try {
      stream = this.client.beta.messages.stream(
        {
          model: this.modelFor(req.model),
          max_tokens: req.maxTokens,
          // Short, grounded school answers: low effort keeps first-token latency ≤ 2 s (TZ §10).
          output_config: { effort: 'low' },
          // Server-side fallback on a safety decline (routes by refusal category).
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          // The system prompt is stable per topic+language → cacheable prefix.
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          messages: req.messages.map((m) => ({ role: m.role, content: m.text })),
        },
        { signal: req.signal },
      );
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') yield { type: 'text', text: ev.delta.text };
      }
      const final = await stream.finalMessage();
      if (final.stop_reason === 'refusal') yield { type: 'refusal' };
      yield {
        type: 'usage',
        inputTokens:
          (final.usage.input_tokens ?? 0) + (final.usage.cache_read_input_tokens ?? 0) + (final.usage.cache_creation_input_tokens ?? 0),
        outputTokens: final.usage.output_tokens ?? 0,
        cachedInputTokens: final.usage.cache_read_input_tokens ?? 0,
      };
    } catch (err) {
      throw providerError(err);
    }
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    try {
      const msg = await this.client.messages.create(
        {
          model: this.modelFor(req.model),
          max_tokens: req.maxTokens,
          // Structured outputs: the reply is JSON matching the schema (validated again server-side).
          output_config: { effort: 'low', format: { type: 'json_schema', schema: req.schema } },
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          messages: [
            {
              role: 'user',
              content: req.images?.length
                ? [
                    ...req.images.flatMap((u) => {
                      const d = parseDataUrl(u);
                      return d ? [{ type: 'image' as const, source: { type: 'base64' as const, media_type: d.mediaType, data: d.data } }] : [];
                    }),
                    { type: 'text' as const, text: req.prompt },
                  ]
                : req.prompt,
            },
          ],
        },
        { signal: req.signal },
      );
      const usage = {
        inputTokens: (msg.usage.input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0),
        outputTokens: msg.usage.output_tokens ?? 0,
      };
      if (msg.stop_reason === 'refusal' || msg.stop_reason === 'max_tokens') return { data: null, usage };
      const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
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

/** Scripted provider for tests. */
export class MockProvider implements TutorProvider {
  readonly name = 'mock';
  readonly calls: ProviderRequest[] = [];
  readonly generateCalls: GenerateRequest[] = [];
  constructor(
    private script: (req: ProviderRequest) => ProviderChunk[] | Error = () => [{ type: 'text', text: 'ok' }],
    private generateScript: (req: GenerateRequest) => unknown = () => ({ items: [] }),
  ) {}
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.generateCalls.push(req);
    const out = this.generateScript(req);
    if (out instanceof Error) throw new ProviderUnavailable(out.message);
    return { data: out, usage: { inputTokens: 50, outputTokens: 30 } };
  }
  async *stream(req: ProviderRequest): AsyncIterable<ProviderChunk> {
    this.calls.push(req);
    const out = this.script(req);
    if (out instanceof Error) throw new ProviderUnavailable(out.message);
    for (const c of out) yield c;
  }
}
