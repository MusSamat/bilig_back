/**
 * LLM provider adapter (TZ §7 «Адаптер к LLM-провайдеру»): the tutor talks to
 * this interface only, so the provider can change without touching the
 * route. The Anthropic adapter streams Claude (`claude-opus-5-5` by default).
 */
import Anthropic from '@anthropic-ai/sdk';

export interface ProviderMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface ProviderRequest {
  model: string;
  system: string;
  messages: ProviderMessage[];
  maxTokens: number;
  signal?: AbortSignal;
}

export type ProviderChunk =
  | { type: 'text'; text: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  /** The model (or its safety layer) declined; the route answers with a polite refusal. */
  | { type: 'refusal' };

export interface TutorProvider {
  readonly name: string;
  stream(req: ProviderRequest): AsyncIterable<ProviderChunk>;
}

export class ProviderUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ProviderUnavailable';
  }
}

const TIMEOUT_MS = 20_000;

export class AnthropicProvider implements TutorProvider {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor(apiKey: string) {
    // maxRetries 1: a failed call falls back to the client's offline index quickly.
    this.client = new Anthropic({ apiKey, maxRetries: 1, timeout: TIMEOUT_MS });
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderChunk> {
    let stream;
    try {
      stream = this.client.beta.messages.stream(
        {
          model: req.model,
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
      };
    } catch (err) {
      if (err instanceof Anthropic.APIUserAbortError) throw new ProviderUnavailable('aborted');
      if (err instanceof Anthropic.RateLimitError) throw new ProviderUnavailable('rate_limited');
      if (err instanceof Anthropic.AuthenticationError) throw new ProviderUnavailable('auth');
      if (err instanceof Anthropic.APIError) throw new ProviderUnavailable(`api_${err.status ?? 'error'}`);
      throw new ProviderUnavailable(err instanceof Error ? err.name : 'provider_error');
    }
  }
}

/** Scripted provider for tests and offline demos. */
export class MockProvider implements TutorProvider {
  readonly name = 'mock';
  readonly calls: ProviderRequest[] = [];
  constructor(private script: (req: ProviderRequest) => ProviderChunk[] | Error = () => [{ type: 'text', text: 'ok' }]) {}
  async *stream(req: ProviderRequest): AsyncIterable<ProviderChunk> {
    this.calls.push(req);
    const out = this.script(req);
    if (out instanceof Error) throw new ProviderUnavailable(out.message);
    for (const c of out) yield c;
  }
}
