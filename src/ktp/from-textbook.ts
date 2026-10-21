/**
 * v0.9.2: a preliminary КТП from a textbook's contents (pure).
 *
 * The contents list every chapter and lesson (§) with its pages, the chapter
 * tests and the lab works. From them and the subject's hours a week this
 * builds the lesson list a teacher would type by hand — without dates: every
 * teacher's timetable differs, they fill the dates in (or upload their own).
 *
 *  1. The lessons in book order: every §; a lab work right after the last
 *     lesson of its topic (or at the chapter end); the chapter test at the end.
 *  2. Fitted to hours a week × weeks (34):
 *     - fewer lessons available → neighbouring § of a chapter are joined, the
 *       shortest pair (by pages) first («§ 4–5»); tests and lab works never;
 *     - more → per chapter an analysis lesson after the test, then problem
 *       solving lessons spread by chapter size, then a final review.
 *
 * Every lesson keeps its pages as homework and its Bilig topic as the link.
 */
import { t, type Lang, type Textbook, type TextbookLesson } from '@bilig/content-model';
import type { KtpLessonType, KtpRow } from '@bilig/content-model/api';

export interface DraftOptions {
  lang: Lang;
  /** Lessons a week. */
  hoursPerWeek: number;
  /** Weeks of lessons (34). */
  weeks: number;
  /** Class labels for the header; their dates stay empty. */
  classes: string[];
  /** Only the chapters of this subject (an integrated book spans several); default: all. */
  subjectKey?: string;
}

// ---------------------------------------------------------------------------
// the lesson list
// ---------------------------------------------------------------------------

type ItemKind = 'lesson' | 'lab' | 'test' | 'analysis' | 'practice' | 'review';

interface Item {
  kind: ItemKind;
  chapter: number;
  /** Book lessons behind this item (two or more when joined). */
  lessons: TextbookLesson[];
  title: string;
}

const T: Record<Lang, { test: (chapter: string) => string; chapter: (n: string, title: string) => string; lab: (n: string) => string; analysis: string; practice: (title: string) => string; review: string; pages: (n: string, from: number, to: number) => string; testHw: string; labHw: string; none: string; plan: (subject: string, grade: number | null) => string }> = {
  ky: {
    test: (x) => `Текшерүү иши: «${x}»`,
    chapter: (n, x) => `${n} глава. ${x}`,
    lab: (n) => `Лабораториялык иш ${n}.`,
    analysis: 'Текшерүү ишинин анализи. Каталар үстүндө иштөө',
    practice: (x) => `Маселе чыгаруу: ${x}`,
    review: 'Жылдык кайталоо',
    pages: (n, a, b) => `${n ? `§ ${n}, ` : ''}${a === b ? `${a}-бет` : `${a}–${b}-беттер`}`,
    testHw: 'Главаны кайталоо',
    labHw: 'Лабораториялык иштин отчетун бүтүрүү',
    none: '',
    plan: (s, g) => `${s}${g ? `, ${g}-класс` : ''}: календардык-тематикалык план (алдын ала)`,
  },
  ru: {
    test: (x) => `Контрольная работа: «${x}»`,
    chapter: (n, x) => `Глава ${n}. ${x}`,
    lab: (n) => `Лабораторная работа ${n}.`,
    analysis: 'Анализ контрольной работы. Работа над ошибками',
    practice: (x) => `Решение задач: ${x}`,
    review: 'Итоговое повторение',
    pages: (n, a, b) => `${n ? `§ ${n}, ` : ''}${a === b ? `с. ${a}` : `с. ${a}–${b}`}`,
    testHw: 'Повторить главу',
    labHw: 'Оформить отчёт о лабораторной работе',
    none: '',
    plan: (s, g) => `${s}${g ? `, ${g} класс` : ''}: календарно-тематический план (предварительный)`,
  },
  en: {
    test: (x) => `Test: «${x}»`,
    chapter: (n, x) => `Chapter ${n}. ${x}`,
    lab: (n) => `Lab work ${n}.`,
    analysis: 'Test review. Correcting mistakes',
    practice: (x) => `Problem solving: ${x}`,
    review: 'Final review',
    pages: (n, a, b) => `${n ? `§ ${n}, ` : ''}${a === b ? `p. ${a}` : `pp. ${a}–${b}`}`,
    testHw: 'Revise the chapter',
    labHw: 'Finish the lab report',
    none: '',
    plan: (s, g) => `${s}${g ? `, grade ${g}` : ''}: scheme of work (draft)`,
  },
};

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV'];
const pagesOf = (ls: readonly TextbookLesson[]) => ls.reduce((n, l) => n + (l.pages ? l.pages.to - l.pages.from + 1 : 2), 0);

function lessonList(tb: Pick<Textbook, 'chapters'>, lang: Lang, subjectKey?: string): { items: Item[]; chapters: { title: string; number: string }[] } {
  const chapters = tb.chapters.filter((c) => !subjectKey || c.subjectKey === subjectKey);
  // Lab works may sit in their own chapter («Лабораториялык иштер»): each goes to the chapter of its topic.
  const isLabChapter = (c: (typeof chapters)[number]) => c.lessons.every((l) => l.kind === 'extra');
  const labs = chapters.filter(isLabChapter).flatMap((c) => c.lessons);
  const real = chapters.filter((c) => !isLabChapter(c));
  const items: Item[] = [];
  const placed = new Set<string>();
  real.forEach((c, ci) => {
    const lessons = c.lessons.filter((l) => l.kind === 'lesson');
    const own = [...labs.filter((l) => !placed.has(l.key) && l.topicKeys.some((k) => lessons.some((x) => x.topicKeys.includes(k)))), ...c.lessons.filter((l) => l.kind === 'extra')];
    for (const l of lessons) {
      items.push({ kind: 'lesson', chapter: ci, lessons: [l], title: t(l.title, lang) });
      // A lab work right after the last lesson of its topic.
      const last = (lab: TextbookLesson) => lessons.filter((x) => x.topicKeys.some((k) => lab.topicKeys.includes(k))).at(-1);
      for (const lab of own) {
        if (placed.has(lab.key) || last(lab)?.key !== l.key) continue;
        placed.add(lab.key);
        items.push({ kind: 'lab', chapter: ci, lessons: [lab], title: `${T[lang].lab(lab.number)} ${t(lab.title, lang)}` });
      }
    }
    for (const lab of own.filter((l) => !placed.has(l.key))) {
      placed.add(lab.key);
      items.push({ kind: 'lab', chapter: ci, lessons: [lab], title: `${T[lang].lab(lab.number)} ${t(lab.title, lang)}` });
    }
    // The book's «test tasks» page becomes the chapter test lesson («Текшерүү иши» — the parser's test type).
    for (const r of c.lessons.filter((l) => l.kind === 'review')) items.push({ kind: 'test', chapter: ci, lessons: [r], title: T[lang].test(t(c.title, lang)) });
  });
  // Arabic chapter numbers print as Roman («I глава»); an unnumbered chapter (the introduction) has none.
  return { items, chapters: real.map((c) => ({ title: t(c.title, lang), number: /^\d+$/.test(c.number) ? (ROMAN[Number(c.number) - 1] ?? c.number) : c.number })) };
}

/**
 * Join neighbouring § of one chapter, the shortest pair first, until `slots` items remain — at most 3 § in
 * a lesson, then (one lesson a week) at most 5; whatever still does not fit is left without a date.
 */
function shrink(items: Item[], slots: number): Item[] {
  return shrinkTo(shrinkTo(items, slots, 3), slots, 5);
}

function shrinkTo(items: Item[], slots: number, maxJoined: number): Item[] {
  const out = [...items];
  while (out.length > slots) {
    let best = -1;
    let bestPages = Infinity;
    for (let i = 0; i + 1 < out.length; i++) {
      const a = out[i];
      const b = out[i + 1];
      if (a.kind !== 'lesson' || b.kind !== 'lesson' || a.chapter !== b.chapter || a.lessons.length + b.lessons.length > maxJoined) continue;
      const p = pagesOf(a.lessons) + pagesOf(b.lessons);
      if (p < bestPages) [best, bestPages] = [i, p];
    }
    if (best < 0) break;
    const [a, b] = [out[best], out[best + 1]];
    out.splice(best, 2, { kind: 'lesson', chapter: a.chapter, lessons: [...a.lessons, ...b.lessons], title: `${a.title}. ${b.title}` });
  }
  return out;
}

/** Fill free slots: an analysis after each chapter test, then problem solving by chapter size, then a final review. */
function grow(items: Item[], slots: number, chapters: { title: string }[], lang: Lang): Item[] {
  const out = [...items];
  let free = slots - out.length;
  if (free <= 0) return out;
  const insertAfter = (pred: (x: Item) => boolean, it: Item) => {
    let i = -1;
    out.forEach((x, k) => {
      if (pred(x)) i = k;
    });
    out.splice(i + 1, 0, it);
  };
  // 1. Analysis after each chapter test.
  for (let ci = 0; ci < chapters.length && free > 0; ci++) {
    if (!out.some((x) => x.kind === 'test' && x.chapter === ci)) continue;
    insertAfter((x) => x.kind === 'test' && x.chapter === ci, { kind: 'analysis', chapter: ci, lessons: [], title: T[lang].analysis });
    free--;
  }
  // 2. A final review lesson, kept for the end.
  const review = free > 0 ? (free--, true) : false;
  // 3. Problem solving before each chapter test, spread by the chapter's number of lessons.
  const size = chapters.map((_, ci) => out.filter((x) => x.chapter === ci && x.kind === 'lesson').length);
  const given = chapters.map(() => 0);
  while (free > 0 && size.some((s) => s > 0)) {
    let ci = 0;
    for (let k = 1; k < size.length; k++) if (size[k] / (given[k] + 1) > size[ci] / (given[ci] + 1)) ci = k;
    insertAfter((x) => x.chapter === ci && (x.kind === 'lesson' || x.kind === 'lab' || x.kind === 'practice'), { kind: 'practice', chapter: ci, lessons: [], title: T[lang].practice(chapters[ci].title) });
    given[ci]++;
    free--;
  }
  if (review) out.push({ kind: 'review', chapter: chapters.length - 1, lessons: [], title: T[lang].review });
  return out;
}

const TYPE: Record<ItemKind, KtpLessonType> = { lesson: 'new', lab: 'practice', test: 'test', analysis: 'analysis', practice: 'practice', review: 'practice' };

export interface DraftKtp {
  title: string;
  grade: number | null;
  classes: string[];
  rows: KtpRow[];
  /** Lessons in the year: hours a week × weeks. */
  lessons: number;
}

export function draftKtpFromTextbook(tb: Pick<Textbook, 'chapters'> & { grade: number | null }, subjectTitle: string, o: DraftOptions): DraftKtp {
  const L = T[o.lang];
  const n = o.hoursPerWeek * o.weeks;
  const { items: base, chapters } = lessonList(tb, o.lang, o.subjectKey);
  const items = base.length > n ? shrink(base, n) : grow(base, n, chapters, o.lang);
  const hours = chapters.map((_, ci) => items.filter((x) => x.chapter === ci).length);
  const rows: KtpRow[] = items.map((it, i) => {
    const ls = it.lessons;
    const nums = ls.map((l) => l.number).filter(Boolean);
    const number = nums.length > 1 ? `${nums[0]}–${nums.at(-1)}` : (nums[0] ?? '');
    const from = Math.min(...ls.map((l) => l.pages?.from ?? Infinity));
    const to = Math.max(...ls.map((l) => l.pages?.to ?? -Infinity));
    const homework =
      it.kind === 'test' ? L.testHw : it.kind === 'lab' ? L.labHw : it.kind === 'lesson' && Number.isFinite(from) ? L.pages(number, from, to) : L.none;
    const title = it.kind === 'lesson' ? `${number ? `§ ${number}. ` : ''}${it.title}` : it.title;
    const topicKey = ls.flatMap((l) => l.topicKeys)[0] ?? null;
    return {
      index: i + 1,
      number: i + 1,
      section: { title: (chapters[it.chapter].number ? L.chapter(chapters[it.chapter].number, chapters[it.chapter].title) : chapters[it.chapter].title).slice(0, 300), hours: hours[it.chapter] },
      title: title.slice(0, 500),
      hours: 1,
      type: TYPE[it.kind],
      dates: Object.fromEntries(o.classes.map((c) => [c, null])),
      homework: homework.slice(0, 1000),
      note: '',
      topicKey,
      ...(topicKey ? { match: { auto: true, score: 1 } } : {}),
    };
  });
  return { title: L.plan(subjectTitle, tb.grade), grade: tb.grade, classes: o.classes, rows, lessons: n };
}
