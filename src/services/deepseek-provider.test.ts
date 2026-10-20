/** DeepSeek adapter against a fake DeepSeek server (the documented wire format). */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { createTutorProvider } from '../bootstrap.js';
import { DeepSeekProvider, FallbackProvider } from './deepseek-provider.js';
import { MockProvider, ProviderUnavailable, type ProviderChunk, type ProviderRequest } from './tutor-provider.js';

interface Seen {
  url: string;
  body: Record<string, unknown>;
  auth: string | null;
}

/** A fetch stand-in: records the request and answers with SSE lines or a JSON body. */
function fakeDeepSeek(answer: { status?: number; sse?: string[]; json?: unknown }) {
  const seen: Seen[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')), auth: headers.get('authorization') });
    if (answer.status && answer.status >= 400)
      return new Response(JSON.stringify({ error: { message: 'x', type: 'x' } }), { status: answer.status, headers: { 'content-type': 'application/json' } });
    if (answer.sse) return new Response(answer.sse.join('\n') + '\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    return new Response(JSON.stringify(answer.json), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, seen };
}

const chunk = (o: object) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash', ...o })}\n`;
const req = (over: Partial<ProviderRequest> = {}): ProviderRequest => ({
  model: 'deepseek-flash',
  system: 'Тема: Ылдамдык. Жооп бер кыргызча.',
  messages: [{ role: 'user', text: 'Ылдамдык деген эмне?' }],
  maxTokens: 600,
  ...over,
});
const collect = async (it: AsyncIterable<ProviderChunk>) => {
  const out: ProviderChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
};

describe('DeepSeekProvider.stream', () => {
  it('streams the answer text, skips keep-alive comments and the reasoning, reports usage; thinking is off for chat', async () => {
    const { f, seen } = fakeDeepSeek({
      sse: [
        ': keep-alive\n',
        chunk({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'ойлонуп жатам…' }, finish_reason: null }] }),
        chunk({ choices: [{ index: 0, delta: { content: 'Ылдамдык — ' }, finish_reason: null }] }),
        chunk({ choices: [{ index: 0, delta: { content: 'жолдун убакытка катышы.' }, finish_reason: 'stop' }] }),
        chunk({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 14, total_tokens: 134, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 20 } }),
        'data: [DONE]\n',
      ],
    });
    const p = new DeepSeekProvider({ apiKey: 'sk-test', fetch: f });
    const out = await collect(p.stream(req()));
    expect(out).toEqual([
      { type: 'text', text: 'Ылдамдык — ' },
      { type: 'text', text: 'жолдун убакытка катышы.' },
      { type: 'usage', inputTokens: 120, outputTokens: 14 },
    ]);
    expect(seen[0].url).toBe('https://api.deepseek.com/chat/completions');
    expect(seen[0].auth).toBe('Bearer sk-test');
    expect(seen[0].body).toMatchObject({
      model: 'deepseek-flash',
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: 'disabled' },
      max_tokens: 600,
      messages: [
        { role: 'system', content: 'Тема: Ылдамдык. Жооп бер кыргызча.' },
        { role: 'user', content: 'Ылдамдык деген эмне?' },
      ],
    });
    expect(seen[0].body).not.toHaveProperty('reasoning_effort');
  });

  it('chat thinking can be turned on: low effort and room for reasoning tokens', async () => {
    const { f, seen } = fakeDeepSeek({ sse: [chunk({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }), 'data: [DONE]\n'] });
    await collect(new DeepSeekProvider({ apiKey: 'k', fetch: f, chatThinking: true }).stream(req()));
    expect(seen[0].body).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'low', max_tokens: 600 + 4096 });
  });

  it('content_filter → refusal; insufficient_system_resource → unavailable', async () => {
    const filtered = fakeDeepSeek({ sse: [chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }] }), 'data: [DONE]\n'] });
    expect(await collect(new DeepSeekProvider({ apiKey: 'k', fetch: filtered.f }).stream(req()))).toContainEqual({ type: 'refusal' });
    const busy = fakeDeepSeek({ sse: [chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'insufficient_system_resource' }] }), 'data: [DONE]\n'] });
    await expect(collect(new DeepSeekProvider({ apiKey: 'k', fetch: busy.f }).stream(req()))).rejects.toMatchObject({ message: 'finish_insufficient_system_resource' });
  });

  it.each([
    [401, 'auth'],
    [402, 'insufficient_balance'],
    [429, 'rate_limited'],
    [503, 'api_503'],
  ])('HTTP %s → ProviderUnavailable(%s)', async (status, reason) => {
    const { f } = fakeDeepSeek({ status });
    const err = await collect(new DeepSeekProvider({ apiKey: 'k', fetch: f }).stream(req())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderUnavailable);
    expect((err as Error).message).toBe(reason);
  });

  it('honours a DeepSeek model setting and ignores a Claude one', async () => {
    const a = fakeDeepSeek({ sse: ['data: [DONE]\n'] });
    await collect(new DeepSeekProvider({ apiKey: 'k', fetch: a.f }).stream(req({ model: 'deepseek-v4-pro' })));
    expect(a.seen[0].body.model).toBe('deepseek-v4-pro');
    const b = fakeDeepSeek({ sse: ['data: [DONE]\n'] });
    await collect(new DeepSeekProvider({ apiKey: 'k', fetch: b.f }).stream(req({ model: 'claude-opus-5-5' })));
    expect(b.seen[0].body.model).toBe('deepseek-flash');
  });
});

describe('DeepSeekProvider.generate', () => {
  const gen = { model: 'deepseek-flash', system: 'sys', prompt: 'Make 2 questions', schema: { type: 'object', properties: { items: { type: 'array' } } }, maxTokens: 1500 };
  const completion = (content: string, finish = 'stop') => ({
    id: 'x',
    object: 'chat.completion',
    created: 1,
    model: 'deepseek-flash',
    choices: [{ index: 0, message: { role: 'assistant', content, reasoning_content: 'r' }, finish_reason: finish }],
    usage: { prompt_tokens: 300, completion_tokens: 200, total_tokens: 500 },
  });

  it('JSON mode with thinking (effort low by default), the schema in a prompt that says «json»', async () => {
    const { f, seen } = fakeDeepSeek({ json: completion('{"items":[{"q":"1"}]}') });
    const out = await new DeepSeekProvider({ apiKey: 'k', fetch: f }).generate(gen);
    expect(out).toEqual({ data: { items: [{ q: '1' }] }, usage: { inputTokens: 300, outputTokens: 200 } });
    expect(seen[0].body).toMatchObject({ response_format: { type: 'json_object' }, thinking: { type: 'enabled' }, reasoning_effort: 'low', max_tokens: 1500 + 4096 });
    const user = (seen[0].body.messages as { role: string; content: string }[]).find((m) => m.role === 'user')!;
    expect(user.content).toMatch(/json/);
    expect(user.content).toContain('"items"');
  });

  it('empty content, a cut-off answer or invalid JSON → no data (the pool still serves)', async () => {
    for (const [content, finish] of [['', 'stop'], ['{"items":', 'length'], ['not json', 'stop']] as const) {
      const { f } = fakeDeepSeek({ json: completion(content, finish) });
      expect((await new DeepSeekProvider({ apiKey: 'k', fetch: f }).generate(gen)).data).toBeNull();
    }
  });

  it('generateEffort none turns thinking off', async () => {
    const { f, seen } = fakeDeepSeek({ json: completion('{}') });
    await new DeepSeekProvider({ apiKey: 'k', fetch: f, generateEffort: 'none' }).generate(gen);
    expect(seen[0].body).toMatchObject({ thinking: { type: 'disabled' }, max_tokens: 1500 });
  });
});

describe('FallbackProvider', () => {
  it('uses the secondary when the primary fails before any text; not after text started', async () => {
    const down = new MockProvider(() => new Error('rate_limited'), () => new Error('rate_limited'));
    const up = new MockProvider(() => [{ type: 'text', text: 'запас' }], () => ({ items: [1] }));
    const reasons: string[] = [];
    const fb = new FallbackProvider(down, up, (_f, _t, r) => reasons.push(r));
    expect(await collect(fb.stream(req()))).toEqual([{ type: 'text', text: 'запас' }]);
    expect((await fb.generate({ model: 'm', system: 's', prompt: 'p', schema: {}, maxTokens: 10 })).data).toEqual({ items: [1] });
    expect(reasons).toEqual(['rate_limited', 'rate_limited']);

    const half: MockProvider = new MockProvider();
    half.stream = async function* () {
      yield { type: 'text', text: 'жарым' };
      throw new ProviderUnavailable('api_500');
    };
    await expect(collect(new FallbackProvider(half, up).stream(req()))).rejects.toThrow('api_500');
  });
});

describe('config: DeepSeek is the provider in use', () => {
  const base = { NODE_ENV: 'development' as const };
  it('a DeepSeek key selects deepseek-flash; Anthropic only when chosen explicitly', () => {
    const c = loadConfig({ ...base, DEEPSEEK_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'sk-ant' });
    expect(c.tutorProvider).toBe('deepseek');
    expect(c.tutorModel).toBe('deepseek-flash');
    expect(createTutorProvider(c)?.name).toBe('deepseek');
    const a = loadConfig({ ...base, TUTOR_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant' });
    expect(a.tutorModel).toBe('claude-opus-5-5');
  });

  it('failover is opt-in; missing keys fail at start', () => {
    const c = loadConfig({ ...base, DEEPSEEK_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'sk-ant', TUTOR_FALLBACK: 'anthropic' });
    expect(createTutorProvider(c)?.name).toBe('deepseek+anthropic');
    expect(() => loadConfig({ ...base, TUTOR_PROVIDER: 'deepseek' })).toThrow(/DEEPSEEK_API_KEY/);
    expect(() => loadConfig({ ...base, DEEPSEEK_API_KEY: 'sk-x', TUTOR_FALLBACK: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/);
  });
});
