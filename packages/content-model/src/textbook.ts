/**
 * v0.5.0: textbooks and their mapping onto topics. One topic, many textbooks:
 * a topic lives on its own; a textbook only maps its chapters and lessons
 * (with page ranges) onto topic keys. The teacher's menu is textbook →
 * chapter → lesson → topic. A lesson may map to several topics, and a review
 * lesson usually maps to every topic of its chapter.
 */
import { z } from 'zod';
import { KeySchema } from './common.js';
import { LangSchema, LocalizedSchema } from './i18n.js';

/** Pages as numbered in the source the textbook entry was made from. */
export const PageRangeSchema = z
  .object({
    from: z.number().int().min(1),
    to: z.number().int().min(1),
  })
  .refine((r) => r.to >= r.from, { message: 'to < from', path: ['to'] });
export type PageRange = z.infer<typeof PageRangeSchema>;

export const LESSON_KINDS = ['lesson', 'review', 'extra'] as const;
export const LessonKindSchema = z.enum(LESSON_KINDS);
export type LessonKind = z.infer<typeof LessonKindSchema>;

export const TextbookLessonSchema = z.object({
  /** Unique inside the textbook (`ch8.l1`). */
  key: KeySchema,
  /** As printed: `8.1`; empty for an unnumbered lesson or a review. */
  number: z.string().max(20),
  kind: LessonKindSchema,
  title: LocalizedSchema,
  pages: PageRangeSchema.optional(),
  /** Topics that teach this lesson, in display order (unknown or unpublished ones are left out of API responses). */
  topicKeys: z.array(KeySchema),
});
export type TextbookLesson = z.infer<typeof TextbookLessonSchema>;

export const TextbookChapterSchema = z.object({
  key: KeySchema,
  /** As printed: `1`…`8`. */
  number: z.string().min(1).max(20),
  title: LocalizedSchema,
  /** Subject this chapter belongs to (an integrated book spans several). */
  subjectKey: KeySchema,
  pages: PageRangeSchema.optional(),
  lessons: z.array(TextbookLessonSchema).min(1),
});
export type TextbookChapter = z.infer<typeof TextbookChapterSchema>;

/** The plain object shape (admin PATCH bodies derive from it); use `TextbookSchema` to validate. */
export const TextbookObjectSchema = z.object({
  key: KeySchema,
  title: LocalizedSchema,
  /** Short name for badges and links («Табигый илимдер 8»); clients fall back to `title`. */
  shortTitle: LocalizedSchema.optional(),
  /** School grade 1–12. */
  grade: z.number().int().min(1).max(12),
  /** Language the book is printed in. */
  lang: LangSchema,
  /** Volume of a multi-part book (`1` = часть 1). */
  part: z.number().int().min(1).optional(),
  authors: z.array(z.string().min(1).max(200)).max(20).optional(),
  publisher: z.string().min(1).max(200).optional(),
  year: z.number().int().min(1990).max(2100).optional(),
  /** Curriculum id, as on courses (`kg-2024`). */
  curriculum: z.string().min(1).optional(),
  order: z.number().int(),
  chapters: z.array(TextbookChapterSchema).min(1),
});

export const TextbookSchema = TextbookObjectSchema.superRefine((t, ctx) => {
  const seen = new Set<string>();
  t.chapters.forEach((c, ci) => {
    if (seen.has(c.key))
      ctx.addIssue({
        code: 'custom',
        path: ['chapters', ci, 'key'],
        message: `duplicate key "${c.key}"`,
      });
    seen.add(c.key);
    c.lessons.forEach((l, li) => {
      if (seen.has(l.key))
        ctx.addIssue({
          code: 'custom',
          path: ['chapters', ci, 'lessons', li, 'key'],
          message: `duplicate key "${l.key}"`,
        });
      seen.add(l.key);
    });
  });
});
export type Textbook = z.infer<typeof TextbookSchema>;

/** Subjects a textbook covers (its chapters' subjects, in order of first appearance). */
export function textbookSubjects(t: Pick<Textbook, 'chapters'>): string[] {
  return [...new Set(t.chapters.map((c) => c.subjectKey))];
}

/** Every topic key a textbook maps to, in reading order, without repeats. */
export function textbookTopicKeys(t: Pick<Textbook, 'chapters'>): string[] {
  return [
    ...new Set(
      t.chapters.flatMap((c) => c.lessons.flatMap((l) => l.topicKeys)),
    ),
  ];
}

/** Keep only lessons' topic keys that pass `keep` (e.g. published topics); chapters and lessons stay. */
export function filterTextbookTopics<T extends Pick<Textbook, 'chapters'>>(
  t: T,
  keep: (topicKey: string) => boolean,
): T {
  return {
    ...t,
    chapters: t.chapters.map((c) => ({
      ...c,
      lessons: c.lessons.map((l) => ({
        ...l,
        topicKeys: l.topicKeys.filter(keep),
      })),
    })),
  };
}

/** Where a topic appears in a textbook (for «§ 8.1, стр. 176–185» on the topic page). */
export interface TextbookPlace {
  textbookKey: string;
  chapterKey: string;
  lessonKey: string;
  number: string;
  pages?: PageRange;
}
export function placesOfTopic(
  textbooks: readonly Textbook[],
  topicKey: string,
): TextbookPlace[] {
  const out: TextbookPlace[] = [];
  for (const t of textbooks)
    for (const c of t.chapters)
      for (const l of c.lessons)
        if (l.kind !== 'review' && l.topicKeys.includes(topicKey))
          out.push({
            textbookKey: t.key,
            chapterKey: c.key,
            lessonKey: l.key,
            number: l.number,
            ...(l.pages ? { pages: l.pages } : {}),
          });
  return out;
}
