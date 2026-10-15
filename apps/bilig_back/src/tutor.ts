/**
 * AI tutor (TZ W-32: "Помощник: онлайн через LLM по материалам темы").
 *
 * Answers in the language of the question (ky/ru/en), grounded in the topic's
 * concepts passed as context. If the LLM is unavailable (no API key, timeout,
 * or error) this throws TutorUnavailable and the route returns 503 — the client
 * then falls back to its offline MiniSearch index (TZ W-32: "офлайн — поиск по
 * локальному индексу"). Mirrors the reference app's 9s timeout + local fallback.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Lang } from '@bilig/content-model';

export class TutorUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'TutorUnavailable';
  }
}

export interface TutorRequest {
  question: string;
  lang: Lang;
  /** Topic + concept context so answers stay grounded (TZ W-32: "по материалам темы"). */
  topicTitle?: string;
  conceptTitle?: string;
  context?: string;
}

const TIMEOUT_MS = 9000; // reference app behaviour

const LANG_NAME: Record<Lang, string> = {
  ky: 'Kyrgyz (кыргызча)',
  ru: 'Russian (русский)',
  en: 'English',
};

function systemPrompt(req: TutorRequest): string {
  const lines = [
    `You are a friendly school science tutor in the Bilig learning app.`,
    `Answer in ${LANG_NAME[req.lang]} — the same language as the question.`,
    `Keep answers short and clear for a school student (2–4 sentences).`,
    `Stay grounded in the topic material provided; do not invent facts.`,
  ];
  if (req.topicTitle) lines.push(`Current topic: ${req.topicTitle}.`);
  if (req.conceptTitle) lines.push(`Focused structure: ${req.conceptTitle}.`);
  if (req.context) lines.push(`Topic material:\n${req.context}`);
  return lines.join('\n');
}

/** Ask the tutor. Throws TutorUnavailable on any failure so the route can 503. */
export async function askTutor(req: TutorRequest): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new TutorUnavailable('no_api_key');
  }
  const client = new Anthropic({ maxRetries: 0 });
  try {
    const res = await client.messages.create(
      {
        model: 'claude-opus-4-8',
        max_tokens: 1024,
        system: systemPrompt(req),
        messages: [{ role: 'user', content: req.question }],
      },
      { timeout: TIMEOUT_MS },
    );
    const answer = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (!answer) throw new TutorUnavailable('empty_answer');
    return answer;
  } catch (err) {
    if (err instanceof TutorUnavailable) throw err;
    throw new TutorUnavailable(
      err instanceof Error ? err.message : 'tutor_error',
    );
  }
}
