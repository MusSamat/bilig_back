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

/** Items quoted in the «do not repeat» list of the prompt. */
export const AVOID_IN_PROMPT = 25;

/** The size the task asks for (validation enforces the same numbers, with a little slack). */
const LIMITS: Record<GenKind, string> = {
  simple: 'Each item: title 2–6 words (≤ 60 characters), text 1–3 short sentences (≤ 320 characters).',
  stem: 'Each item: title 2–6 words (≤ 60 characters), text 1–3 short sentences (≤ 320 characters), field one of s, t, e, m.',
  quiz: 'Each item: question ≤ 220 characters, 3–4 options of ≤ 100 characters (2 only for a true/false question), no «all/none of the above», explanation 1–2 sentences (≤ 300 characters).',
};
export const MAX_LEN = { title: 80, text: 400, prompt: 260, option: 120, explanation: 360 } as const;

const KY_LETTERS = /[өүңӨҮҢ]/;
const KAZAKH = /[әғқұһіӘҒҚҰҺІ]/;
const CYRILLIC = /[\u0400-\u04FF]/;
/** Frequent Kyrgyz words and endings (Kyrgyz text can lack ө/ү/ң: «Бардык клеткалардын ядросу бар»). */
const KY_MARKERS = [
  /(^|[^\p{L}])(жана|менен|үчүн|учун|бул|булар|алар|деп|эмес|бар|жок|болот|болгон|болуп|экен|керек|дагы|эле|кандай|эмне|кайсы|канча|туура|бардык|көп|аз|ар|бир|эки|өтө|абдан|болсо)(?=[^\p{L}]|$)/giu,
  /\p{L}{2,}(дын|дин|дун|дүн|тын|тин|тун|түн|нын|нин|нун|нүн|ны|ни|ну|нү|га|ге|ка|ке|да|де|та|те|дан|ден|тан|тен|лар|лер|дар|дер|тар|тер|ган|ген|кан|кен|ат|ыш|уш)(?=[^\p{L}]|$)/giu,
];
/** Frequent Russian words and endings. */
const RU_MARKERS = [
  /(^|[^\p{L}])(и|в|во|на|что|это|не|по|из|для|как|или|при|если|есть|он|она|они|оно|у|с|к|от|до|же|мы|вы|его|её|их|который|которая|которые)(?=[^\p{L}]|$)/giu,
  /\p{L}{2,}(ость|ение|ание|ться|ются|ется|ого|его|ому|ему|ыми|ими|ая|яя|ое|ее|ые|ие)(?=[^\p{L}]|$)/giu,
];
const score = (text: string, res: RegExp[]) => res.reduce((n, re) => n + (text.match(re)?.length ?? 0), 0);
/**
 * Is `text` plausibly written in `lang`? Cheap checks where models drift:
 * Kyrgyz never has Kazakh letters, and unless it has ө/ү/ң its Kyrgyz word and
 * ending markers must outweigh Russian ones; Russian must not have Kyrgyz or
 * Kazakh letters; English must not be Cyrillic. Short texts get the benefit of the doubt.
 */
export function looksLikeLang(text: string, lang: Lang): boolean {
  if (lang === 'en') return !CYRILLIC.test(text);
  if (!CYRILLIC.test(text) || KAZAKH.test(text)) return false;
  if (lang === 'ru') return !KY_LETTERS.test(text);
  if (KY_LETTERS.test(text) || text.length < 40) return true;
  return score(text, KY_MARKERS) > score(text, RU_MARKERS);
}
/** «All of the above» and friends make a bad single-choice question. */
const META_OPTION = /^(all|none|both) (of )?(the )?(above|answers)|^все (ответы|вышеперечисленн)|^ни один|^оба |^баары|^бардыгы|^эч бири|^жогорудагы/i;

/**
 * The user turn for a generation request. Everything here is server-authored:
 * the focus title comes from the package, and «avoid» lists earlier items
 * (model output or authored content), never free text from the client.
 */
export function buildGeneratePrompt(kind: GenKind, lang: Lang, count: number, focus: ResolvedConcept | undefined, pkg: ContentPackage, avoid: string[]): string {
  const focusText = focus ? `the structure [[${focus.key}]] ${t(focus.title, lang)}` : `the topic «${t(pkg.topic.title, lang)}»`;
  return [
    TASK[kind].replace('{count}', String(count)).replace('{focus}', focusText),
    `Use ONLY facts from the topic material. Write in ${LANG_NAME[lang]} only${lang === 'ky' ? ' (correct Kyrgyz with ө ү ң; not Kazakh, not Russian)' : ''}. Set conceptKey to a key from the material when an item is about one structure.`,
    LIMITS[kind],
    'Do not write [[markers]] inside the texts.',
    // The newest items only, short: the server still rejects ANY duplicate of the whole pool (free), so
    // the model needs just enough to steer away — 25 × 140 chars instead of 60 × 200 (≈ 4k → ≈ 1.2k tokens).
    avoid.length ? `Do not repeat or rephrase these existing items:\n${avoid.slice(-AVOID_IN_PROMPT).reverse().map((a) => `- ${a.slice(0, 140)}`).join('\n')}` : '',
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
export function validateGenerated(kind: GenKind, data: unknown, validKeys: ReadonlySet<string>, avoid: ReadonlySet<string>, max: number, lang?: Lang): ValidatedGeneration {
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
      const prompt = clean(p.data.prompt, 2000);
      const explanation = clean(p.data.explanation, 2000);
      const options = p.data.options.map((o) => ({ key: o.key.trim().toLowerCase(), text: clean(o.text, 1000) })).filter((o) => o.text && KEY_RE.test(o.key));
      const distinct = new Set(options.map((o) => o.key)).size === options.length && new Set(options.map((o) => o.text.toLowerCase())).size === options.length;
      const sig = draftSignature(prompt);
      const tooLong = prompt.length > MAX_LEN.prompt || explanation.length > MAX_LEN.explanation || options.some((o) => o.text.length > MAX_LEN.option);
      const wrongLang = !!lang && !looksLikeLang([prompt, explanation, ...options.map((o) => o.text)].join(' '), lang);
      const meta = options.some((o) => META_OPTION.test(o.text.trim()));
      if (!prompt || !explanation || options.length < 2 || options.length > 4 || !distinct || tooLong || wrongLang || meta || !options.some((o) => o.key === p.data.answer.trim().toLowerCase()) || seen.has(sig)) {
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
      const title = clean(p.data.title, 2000);
      const text = clean(p.data.text, 2000);
      const sig = draftSignature(text);
      const field = kind === 'stem' && (STEM_FIELDS as readonly string[]).includes((p.data.field ?? '').trim().toLowerCase()) ? ((p.data.field ?? '').trim().toLowerCase() as DraftExample['field']) : undefined;
      const tooLong = title.length > MAX_LEN.title || text.length > MAX_LEN.text;
      const wrongLang = !!lang && !looksLikeLang(`${title} ${text}`, lang);
      if (!title || !text || tooLong || wrongLang || (kind === 'stem' && !field) || seen.has(sig) || seen.has(draftSignature(title))) {
        out.rejected++;
        continue;
      }
      seen.add(sig);
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
