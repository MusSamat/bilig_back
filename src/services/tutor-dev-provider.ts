/**
 * `TUTOR_PROVIDER=dev`: a provider with no LLM behind it (development only,
 * refused in production). Answers and generated items are assembled from the
 * published package by the contract's pure helpers (`groundedAnswer`,
 * `groundedGenerate`), so the whole tutor pipeline — limits, masking,
 * citations, suggestions, the generation pool and its review queue — runs
 * end to end before an API key exists. It costs no tokens.
 */
import { groundedAnswer, groundedGenerate } from '@bilig/content-model';
import type { GenerateRequest, GenerateResult, ProviderChunk, ProviderRequest, TutorProvider } from './tutor-provider.js';

const NO_GROUNDING = '[[no-answer]]';

export class DevProvider implements TutorProvider {
  readonly name = 'dev';

  async *stream(req: ProviderRequest): AsyncIterable<ProviderChunk> {
    const g = req.grounding;
    const text = g ? groundedAnswer(g.pkg, g.lang, { question: g.question ?? '', conceptKey: g.conceptKey, quote: g.quote, intent: g.intent }).text : NO_GROUNDING;
    // Word-sized chunks, like a real stream (exercises the split-marker parser).
    for (const piece of text.split(/(?<=\s)/)) yield { type: 'text', text: piece };
    yield { type: 'usage', inputTokens: 0, outputTokens: 0 };
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const g = req.grounding;
    if (!g) return { data: { items: [] }, usage: { inputTokens: 0, outputTokens: 0 } };
    const r = groundedGenerate(g.pkg, g.lang, g.kind, { conceptKey: g.conceptKey, count: g.count, avoid: g.avoid });
    return { data: { items: g.kind === 'quiz' ? r.quiz : r.examples }, usage: { inputTokens: 0, outputTokens: 0 } };
  }
}
