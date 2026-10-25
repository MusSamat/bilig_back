/**
 * v0.10.0: the model prompts of the teacher cabinet (pure, except the call made by the caller): the
 * assistant of a lesson page (materials / ask / draft) and the chapters of a КТП drafted from the
 * subject standard when there is no textbook. Every answer is strict JSON (a schema), checked again here.
 */
import type { Lang, LessonModel } from '@bilig/content-model';
import { ASSIST_MAX_ITEMS, emptyLessonGoals, type LessonAssistRequest, type LessonGoals, type LessonMaterialKind } from '@bilig/content-model/api';
import { z } from 'zod';

const LANG_NAME: Record<Lang, string> = { ky: 'Kyrgyz', ru: 'Russian', en: 'English' };

export const ASSIST_SYSTEM =
  'You help school teachers in the Kyrgyz Republic prepare lessons. You follow the state subject standard and the official lesson plan form. Be concrete, correct and age-appropriate. Never invent personal data.';

export interface LessonContext {
  title: string;
  section: string | null;
  subjectName: string;
  grade: number | null;
  /** The linked Bilig topic's title, when there is one. */
  topicTitle: string | null;
  homework: string;
}

const contextBlock = (c: LessonContext) =>
  [
    '<lesson>',
    `Subject: ${c.subjectName || '—'}`,
    c.grade ? `Grade: ${c.grade}` : '',
    c.section ? `Chapter: ${c.section}` : '',
    `Lesson topic: ${c.title}`,
    c.topicTitle && c.topicTitle !== c.title ? `Bilig topic: ${c.topicTitle}` : '',
    c.homework ? `Homework in the КТП: ${c.homework}` : '',
    '</lesson>',
  ]
    .filter(Boolean)
    .join('\n');

const KIND: Record<LessonMaterialKind, string> = {
  examples: 'worked examples or short explanatory examples (each one self-contained, with the answer)',
  stem: 'STEM tasks that link the topic to real life, engineering or nature (each one a short task with what pupils must find or build)',
  tests: 'multiple-choice test questions (each one: the question, then the options a) b) c) d) on new lines, then «Answer: x»)',
  slides: 'presentation slides (each one: a short title on the first line, then 2–4 short bullet lines)',
};

const str = (max: number) => z.string().catch('').transform((s) => s.trim().slice(0, max));

// --- materials ------------------------------------------------------------------------

export const MATERIALS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { items: { type: 'array', items: { type: 'string' } } },
  required: ['items'],
};

export function materialsPrompt(c: LessonContext, kind: LessonMaterialKind, count: number, exclude: readonly string[], lang: Lang): string {
  return [
    contextBlock(c),
    `Write ${count} new ${KIND[kind]} for this lesson, in ${LANG_NAME[lang]}.`,
    exclude.length ? `They must differ from these, which the teacher already has:\n<have>\n${exclude.map((x) => `- ${x.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n')}\n</have>` : '',
    'Answer with json only: {"items": [...]}.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function materialsOf(data: unknown, count: number, exclude: readonly string[]): string[] {
  const r = z.object({ items: z.array(str(2000)).catch([]) }).safeParse(data);
  if (!r.success) return [];
  const have = new Set(exclude.map((x) => x.trim().toLocaleLowerCase('ru')));
  const out: string[] = [];
  for (const it of r.data.items) if (it && !have.has(it.toLocaleLowerCase('ru')) && !out.includes(it)) out.push(it);
  return out.slice(0, Math.min(count, ASSIST_MAX_ITEMS));
}

// --- ask ------------------------------------------------------------------------------

export const ASK_SCHEMA = { type: 'object', additionalProperties: false, properties: { answer: { type: 'string' } }, required: ['answer'] };

export function askPrompt(c: LessonContext, req: Extract<LessonAssistRequest, { task: 'ask' }>, lang: Lang): string {
  const history = (req.history ?? []).slice(-12).map((h) => `${h.role === 'teacher' ? 'Teacher' : 'Assistant'}: ${h.text.slice(0, 1500)}`);
  return [
    contextBlock(c),
    history.length ? `<chat>\n${history.join('\n')}\n</chat>` : '',
    `The teacher asks: <question>${req.question}</question>`,
    `Answer in ${LANG_NAME[lang]}, practically and briefly (at most 8 sentences or a short list). Answer with json only: {"answer": "..."}.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export const answerOf = (data: unknown): string => z.object({ answer: str(4000) }).safeParse(data).data?.answer ?? '';

// --- draft ----------------------------------------------------------------------------

const GOAL = { type: 'object', additionalProperties: false, properties: { goal: { type: 'string' }, result: { type: 'string' } }, required: ['goal', 'result'] };
export const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    stages: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, properties: { key: { type: 'string' }, teacher: { type: 'string' }, pupil: { type: 'string' } }, required: ['key', 'teacher', 'pupil'] },
    },
    goals: { type: 'object', additionalProperties: false, properties: { knowledge: GOAL, development: GOAL, upbringing: GOAL }, required: ['knowledge', 'development', 'upbringing'] },
  },
  required: ['stages', 'goals'],
};

export function draftPrompt(c: LessonContext, model: LessonModel, lang: Lang): string {
  return [
    contextBlock(c),
    `Plan this 45-minute lesson with the «${model.full}» lesson model (${model.idea}). Its stages:`,
    model.stages.map((s) => `- key "${s.key}": ${s.code} — ${s.title}, about ${s.minutes} min. ${s.text} Teacher: ${s.teacher.join('; ')}. Pupils: ${s.pupil}.`).join('\n'),
    `For every stage write what the teacher does and what the pupils do for THIS topic (2–4 sentences each), and the three lesson goals of the official form with their expected results: knowledge (билим берүүчүлүк), development (өнүктүрүүчүлүк), upbringing (тарбиялык). Write in ${LANG_NAME[lang]}.`,
    'Answer with json only.',
  ].join('\n\n');
}

export function draftOf(data: unknown, model: LessonModel): { stages: Record<string, { teacher: string; pupil: string }>; goals: LessonGoals } {
  const Goal = z.object({ goal: str(2000), result: str(2000) }).catch({ goal: '', result: '' });
  const r = z
    .object({
      stages: z.array(z.object({ key: z.string().catch(''), teacher: str(4000), pupil: str(4000) })).catch([]),
      goals: z.object({ knowledge: Goal, development: Goal, upbringing: Goal }).catch(emptyLessonGoals()),
    })
    .safeParse(data);
  const got = r.success ? r.data : { stages: [], goals: emptyLessonGoals() };
  const stages: Record<string, { teacher: string; pupil: string }> = {};
  for (const s of model.stages) {
    const hit = got.stages.find((x) => x.key === s.key);
    stages[`${model.id}:${s.key}`] = { teacher: hit?.teacher ?? '', pupil: hit?.pupil ?? '' };
  }
  return { stages, goals: got.goals };
}

// --- a КТП from the subject standard ----------------------------------------------------

export const STANDARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          lessons: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' }, kind: { type: 'string', enum: ['lesson', 'lab', 'test'] } }, required: ['title', 'kind'] },
          },
        },
        required: ['title', 'lessons'],
      },
    },
  },
  required: ['chapters'],
};

export function standardPrompt(o: { subjectName: string; grade: number; lang: Lang; lessons: number }): string {
  return [
    `Draft the calendar-thematic plan (КТП) of «${o.subjectName}» for grade ${o.grade} of a general school in the Kyrgyz Republic, following the state subject standard and curriculum of the Kyrgyz Republic.`,
    `The year has ${o.lessons} lessons (hours a week × school weeks). Give the chapters (sections) in teaching order and, in each, its lessons in order: new-material lessons by topic, and the laboratory and practical works where the subject has them (kind "lab", titled as the work, e.g. «Лабораториялык иш: …» / «Лабораторная работа: …»). End each chapter with its test (kind "test").`,
    `About ${o.lessons} lessons in all; when unsure, give fewer topics rather than invent them. Titles are short topic names as in a КТП, in ${LANG_NAME[o.lang]}, without numbers.`,
    'Answer with json only.',
  ].join('\n');
}

export interface StandardChapter {
  title: string;
  lessons: { title: string; kind: 'lesson' | 'lab' | 'test' }[];
}

export function standardOf(data: unknown): StandardChapter[] {
  const r = z
    .object({
      chapters: z
        .array(
          z.object({
            title: str(300),
            lessons: z.array(z.object({ title: str(500), kind: z.enum(['lesson', 'lab', 'test']).catch('lesson') })).catch([]),
          }),
        )
        .catch([]),
    })
    .safeParse(data);
  if (!r.success) return [];
  return r.data.chapters
    .map((c) => ({ title: c.title, lessons: c.lessons.filter((l) => l.title).slice(0, 200) }))
    .filter((c) => c.title && c.lessons.length)
    .slice(0, 60);
}
