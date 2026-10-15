/**
 * AI tutor (TZ W-32: "Помощник: онлайн через LLM по материалам темы").
 *
 * Answers in the question's language, grounded in the topic package. On any
 * LLM failure (no key, timeout, error) throws TutorUnavailable → the route
 * returns 503 problem+json and the client falls back to its offline index.
 * No user names or ids are sent to the provider (TZ §6).
 */
import Anthropic from '@anthropic-ai/sdk';
import { t, topicConcepts, type ContentPackage, type Lang } from '@bilig/content-model';
import type { TutorAskRequest, TutorAskResponse } from '@bilig/content-model/api';

export class TutorUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'TutorUnavailable';
  }
}

const TIMEOUT_MS = 9000;

const LANG_NAME: Record<Lang, string> = {
  ky: 'Kyrgyz (кыргызча)',
  ru: 'Russian (русский)',
  en: 'English',
};

/** Topic material used for grounding (exported for tests). */
export function topicContext(pkg: ContentPackage, lang: Lang): string {
  const concepts = topicConcepts(pkg)
    .map((c) => `- [${c.key}] ${t(c.title, lang)}: ${t(c.description, lang)}`)
    .join('\n');
  return `${t(pkg.topic.title, lang)} — ${t(pkg.topic.description, lang)}\nStructures:\n${concepts}`;
}

function systemPrompt(req: TutorAskRequest, pkg: ContentPackage): string {
  const focus = req.conceptKey ? pkg.concepts.find((c) => c.key === req.conceptKey) : undefined;
  return [
    'You are a friendly school science tutor in the Bilig learning app.',
    `Answer in ${LANG_NAME[req.lang]} — the same language as the question.`,
    'Keep answers short and clear for a school student (2–4 sentences).',
    'Stay grounded in the topic material provided; do not invent facts.',
    focus ? `Focused structure: ${t(focus.title, req.lang)} [${focus.key}].` : '',
    `Topic material:\n${topicContext(pkg, req.lang)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Concept keys mentioned in the answer by title (in any language) or the focused one. */
export function citationsFor(answer: string, pkg: ContentPackage, focusKey?: string): string[] {
  const lower = answer.toLocaleLowerCase();
  const keys = topicConcepts(pkg)
    .filter((c) => Object.values(c.title).some((v) => v && lower.includes(v.toLocaleLowerCase())))
    .map((c) => c.key);
  if (focusKey && pkg.topic.conceptKeys.includes(focusKey) && !keys.includes(focusKey)) keys.unshift(focusKey);
  return keys;
}

/** Ask the tutor. Throws TutorUnavailable on any failure so the route can 503. */
export async function askTutor(req: TutorAskRequest, pkg: ContentPackage): Promise<TutorAskResponse> {
  if (!process.env.ANTHROPIC_API_KEY) throw new TutorUnavailable('no_api_key');
  const client = new Anthropic({ maxRetries: 0 });
  try {
    const res = await client.messages.create(
      {
        model: 'claude-opus-4-8',
        max_tokens: 1024,
        system: systemPrompt(req, pkg),
        messages: [
          ...(req.history ?? []).map((m) => ({ role: m.role, content: m.text })),
          { role: 'user' as const, content: req.question },
        ],
      },
      { timeout: TIMEOUT_MS },
    );
    const answer = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (!answer) throw new TutorUnavailable('empty_answer');
    return { answer, citations: citationsFor(answer, pkg, req.conceptKey) };
  } catch (err) {
    if (err instanceof TutorUnavailable) throw err;
    throw new TutorUnavailable(err instanceof Error ? err.message : 'tutor_error');
  }
}
