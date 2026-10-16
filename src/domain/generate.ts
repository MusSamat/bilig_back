/**
 * «Ещё примеры» / «Ещё вопросы» (contract 0.4.0, POST /tutor/generate):
 * the task prompt, the JSON Schema the model must answer with (structured
 * outputs), and the server-side validation every generated item passes before
 * it is stored or shown. The system prompt (topic material + safety rules) is
 * the same as for questions, so the model only sees the published package.
 */
import { z } from 'zod';
import { KEY_RE, STEM_FIELDS, draftSignature, t, type ContentPackage, type DraftExample, type DraftQuizItem, type Lang, type ResolvedConcept } from '@bilig/content-model';
import { LANG_NAME } from './tutor.js';

export type GenKind = 'simple' | 'stem' | 'quiz';

const exampleItem = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: 'Short title, 2–6 words' },
    text: { type: 'string', description: '1–3 short sentences' },
    field: { type: 'string', enum: [...STEM_FIELDS], description: 'S = science, T = technology, E = engineering, M = math' },
    conceptKey: { type: 'string', description: 'Key of the structure from the material this is about' },
  },
  required: ['title', 'text'],
};
const quizItem = {
  type: 'object',
  additionalProperties: false,
  properties: {
    prompt: { type: 'string' },
    options: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, properties: { key: { type: 'string', enum: ['a', 'b', 'c', 'd'] }, text: { type: 'string' } }, required: ['key', 'text'] },
    },
    answer: { type: 'string', enum: ['a', 'b', 'c', 'd'] },
    explanation: { type: 'string', description: 'Why the answer is right, from the material, 1–2 sentences' },
    conceptKey: { type: 'string' },
  },
  required: ['prompt', 'options', 'answer', 'explanation'],
};

/** JSON Schema for structured outputs: `{ items: [...] }`. */
export function generateSchema(kind: GenKind): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: { items: { type: 'array', items: kind === 'quiz' ? quizItem : exampleItem } },
    required: ['items'],
  };
}

const TASK: Record<GenKind, string> = {
  simple:
    'Write {count} NEW plain everyday comparisons ("simply put" examples) that help a 10–16 year old understand {focus}. Each is a familiar situation from home, school or the street in Kyrgyzstan, compared to the science.',
  stem:
    'Write {count} NEW real-world STEM examples about {focus}: where people use it in science, technology, engineering or mathematics. Set `field` to the matching letter (s, t, e, m).',
  quiz:
    'Write {count} NEW single-choice practice questions about {focus} for the teacher to show to the class. Each has 3–4 options with keys a–d, exactly one correct `answer`, plausible wrong options, and a short `explanation` from the material.',
};

/**
 * The user turn for a generation request. Everything here is server-authored:
 * the focus title comes from the package, and «avoid» lists earlier items
 * (model output or authored content), never free text from the client.
 */
export function buildGeneratePrompt(kind: GenKind, lang: Lang, count: number, focus: ResolvedConcept | undefined, pkg: ContentPackage, avoid: string[]): string {
  const focusText = focus ? `the structure [[${focus.key}]] ${t(focus.title, lang)}` : `the topic «${t(pkg.topic.title, lang)}»`;
  return [
    TASK[kind].replace('{count}', String(count)).replace('{focus}', focusText),
    `Use ONLY facts from the topic material. Write in ${LANG_NAME[lang]}. Set conceptKey to a key from the material when an item is about one structure.`,
    'Do not write [[markers]] inside the texts.',
    avoid.length ? `Do not repeat or rephrase these existing items:\n${avoid.slice(0, 60).map((a) => `- ${a}`).join('\n')}` : '',
    'Answer with JSON only: {"items": [...]}.',
  ]
    .filter(Boolean)
    .join('\n');
}

const clean = (s: string, max: number) =>
  s
    .replace(/\[\[[^\]]*\]\]/g, '')
    .replace(/<[^>]{0,40}>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const RawExample = z.object({ title: z.string(), text: z.string(), field: z.string().optional(), conceptKey: z.string().optional() });
const RawQuiz = z.object({
  prompt: z.string(),
  options: z.array(z.object({ key: z.string(), text: z.string() })),
  answer: z.string(),
  explanation: z.string(),
  conceptKey: z.string().optional(),
});

export interface ValidatedGeneration {
  examples: DraftExample[];
  quiz: DraftQuizItem[];
  /** Items dropped by validation (logged; a high rate means a prompt or model problem). */
  rejected: number;
}

/**
 * Validate and normalise model output. An item is dropped unless it is
 * complete, within length limits, not a duplicate (of `avoid` or of another
 * item) and — for questions — has 2–5 distinct options with the answer among
 * them. Unknown concept keys are removed, never shown.
 */
export function validateGenerated(kind: GenKind, data: unknown, validKeys: ReadonlySet<string>, avoid: ReadonlySet<string>, max: number): ValidatedGeneration {
  const out: ValidatedGeneration = { examples: [], quiz: [], rejected: 0 };
  const items = (data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items) ? (data as { items: unknown[] }).items : []) as unknown[];
  const seen = new Set(avoid);
  const key = (k: string | undefined) => (k && KEY_RE.test(k) && validKeys.has(k) ? k : undefined);
  for (const raw of items.slice(0, max * 2)) {
    if (kind === 'quiz') {
      const p = RawQuiz.safeParse(raw);
      if (!p.success) {
        out.rejected++;
        continue;
      }
      const prompt = clean(p.data.prompt, 500);
      const explanation = clean(p.data.explanation, 1000);
      const options = p.data.options.map((o) => ({ key: o.key.trim().toLowerCase(), text: clean(o.text, 200) })).filter((o) => o.text && KEY_RE.test(o.key));
      const distinct = new Set(options.map((o) => o.key)).size === options.length && new Set(options.map((o) => o.text.toLowerCase())).size === options.length;
      const sig = draftSignature(prompt);
      if (!prompt || !explanation || options.length < 2 || options.length > 5 || !distinct || !options.some((o) => o.key === p.data.answer.trim().toLowerCase()) || seen.has(sig)) {
        out.rejected++;
        continue;
      }
      seen.add(sig);
      const ck = key(p.data.conceptKey);
      out.quiz.push({ prompt, options, answer: p.data.answer.trim().toLowerCase(), explanation, ...(ck ? { conceptKey: ck } : {}) });
      if (out.quiz.length >= max) break;
    } else {
      const p = RawExample.safeParse(raw);
      if (!p.success) {
        out.rejected++;
        continue;
      }
      const title = clean(p.data.title, 200);
      const text = clean(p.data.text, 1000);
      const sig = draftSignature(text);
      if (!title || !text || seen.has(sig) || seen.has(draftSignature(title))) {
        out.rejected++;
        continue;
      }
      seen.add(sig);
      const field = kind === 'stem' && (STEM_FIELDS as readonly string[]).includes(p.data.field ?? '') ? (p.data.field as DraftExample['field']) : undefined;
      const ck = key(p.data.conceptKey);
      out.examples.push({ title, text, ...(field ? { field } : {}), ...(ck ? { conceptKey: ck } : {}) });
      if (out.examples.length >= max) break;
    }
  }
  return out;
}

/** Signature of a stored payload (what `avoid` and duplicate checks compare). */
export const payloadSignature = (kind: GenKind, payload: DraftExample | DraftQuizItem): string =>
  draftSignature(kind === 'quiz' ? (payload as DraftQuizItem).prompt : (payload as DraftExample).text);

/** Human-readable line for the «do not repeat» list in the prompt. */
export const payloadLine = (kind: GenKind, payload: DraftExample | DraftQuizItem): string =>
  (kind === 'quiz' ? (payload as DraftQuizItem).prompt : `${(payload as DraftExample).title}: ${(payload as DraftExample).text}`).slice(0, 200);
