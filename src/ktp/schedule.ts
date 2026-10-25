/**
 * v0.10.0: dates of a КТП class column from the teacher's lesson days (pure). The calendar's study slots
 * (one per lesson hour; holidays and the days between quarters skipped) are given to the lessons in КТП
 * order: a lesson takes `hours` slots and is dated by its first one; a lesson of 0 hours takes none and
 * gets the date of the next slot. Lessons beyond the year's last slot keep no date (the checks show them).
 *
 *  - `all`: every lesson is placed anew;
 *  - `empty`: dated lessons keep their dates (and the slots of those dates); a lesson without one gets
 *    the first free slot after the lesson before it.
 *  - `assessments`: the last slot of every quarter is a «СОЧ», a quarter of more than 8 slots gets two
 *    «СОР» at its thirds; when the year still has more hours than lessons, evenly spaced `new` lessons are
 *    taught in two parts and whatever remains becomes review lessons. A plan that already has a СОЧ gets
 *    no new assessments (scheduling again must not add them twice).
 */
import type { Lang } from '@bilig/content-model';
import { studySlots, type KtpRow, type SchoolCalendar, type StudySlot, type Weekdays } from '@bilig/content-model/api';
import { newRowUid } from './row-uid.js';

export interface ScheduleOptions {
  cls: string;
  classes: readonly string[];
  weekdays: Weekdays;
  mode: 'empty' | 'all';
  from?: string;
  assessments?: boolean;
  lang: Lang;
}

const T: Record<Lang, { sor: (n: number, section: string) => string; soch: (q: number) => string; part: (k: number) => string; review: string }> = {
  ky: { sor: (n, s) => `СОР №${n}${s ? `. ${s}` : ''}`, soch: (q) => `${q}-чейрек боюнча СОЧ`, part: (k) => `(${k}-бөлүк)`, review: 'Кайталоо жана жалпылоо' },
  ru: { sor: (n, s) => `СОР №${n}${s ? `. ${s}` : ''}`, soch: (q) => `СОЧ за ${q} четверть`, part: (k) => `(часть ${k})`, review: 'Повторение и обобщение' },
  en: { sor: (n, s) => `Unit summative assessment №${n}${s ? `. ${s}` : ''}`, soch: (q) => `Term ${q} summative assessment`, part: (k) => `(part ${k})`, review: 'Review and consolidation' },
};

/** Slot indexes kept for assessments: the last slot of each quarter (СОЧ), the thirds of a long quarter (СОР). */
export function assessmentSlots(slots: readonly StudySlot[]): Map<number, { kind: 'sor' | 'soch'; quarter: number }> {
  const out = new Map<number, { kind: 'sor' | 'soch'; quarter: number }>();
  for (const q of [1, 2, 3, 4]) {
    const idx = slots.flatMap((s, i) => (s.quarter === q ? [i] : []));
    if (!idx.length) continue;
    const n = idx.length;
    if (n > 8) for (const at of [Math.floor(n / 3) - 1, Math.floor((2 * n) / 3) - 1]) out.set(idx[at], { kind: 'sor', quarter: q });
    out.set(idx[n - 1], { kind: 'soch', quarter: q });
  }
  return out;
}

const emptyDates = (classes: readonly string[]) => Object.fromEntries(classes.map((c) => [c, null])) as Record<string, string | null>;

/** Rows with assessments added (and big topics split / review lessons added); dates of `cls` from the simulation. */
function withAssessments(rows: readonly KtpRow[], slots: readonly StudySlot[], o: ScheduleOptions): KtpRow[] {
  const L = T[o.lang];
  const reserved = assessmentSlots(slots);
  const free = slots.length - reserved.size;
  let lessons = rows.map((r) => ({ ...r, dates: { ...r.dates } }));
  const hours = lessons.reduce((n, r) => n + r.hours, 0);
  let extra = free - hours;
  if (extra > 0) {
    // Teach evenly spaced new-material lessons in two parts.
    const singles = lessons.filter((r) => r.type === 'new' && r.hours === 1);
    const k = Math.min(extra, singles.length);
    const split = new Set(Array.from({ length: k }, (_, j) => singles[Math.floor(((j + 0.5) * singles.length) / k)].uid));
    lessons = lessons.flatMap((r) =>
      split.has(r.uid)
        ? [
            { ...r, title: `${r.title} ${L.part(1)}`.slice(0, 500) },
            { ...structuredClone(r), uid: newRowUid(), title: `${r.title} ${L.part(2)}`.slice(0, 500), dates: emptyDates(o.classes) },
          ]
        : [r],
    );
    extra -= k;
    const last = lessons.at(-1);
    for (let i = 0; i < extra; i++)
      lessons.push({ uid: newRowUid(), index: 0, number: 0, ...(last?.section ? { section: { ...last.section } } : {}), title: L.review, hours: 1, type: 'practice', dates: emptyDates(o.classes), homework: '', note: '', topicKey: null });
  }
  // Walk the slots: a reserved slot is an assessment, the others go to the lessons in order.
  const out: KtpRow[] = [];
  let sor = 0;
  let li = 0;
  let left = 0; // slots the current lesson still takes
  const dated = (r: KtpRow, date: string | null): KtpRow => ({ ...r, dates: { ...r.dates, [o.cls]: date } });
  // Lessons of 0 hours ride on the next slot without taking it.
  const zeros = (date: string | null) => {
    while (li < lessons.length && lessons[li].hours === 0) out.push(dated(lessons[li++], date));
  };
  slots.forEach((s, i) => {
    const a = reserved.get(i);
    if (a) {
      const prev = out.at(-1);
      const section = prev?.section;
      const title = a.kind === 'soch' ? L.soch(a.quarter) : L.sor(++sor, section?.title ?? '');
      out.push({ uid: newRowUid(), index: 0, number: 0, ...(section ? { section: { ...section } } : {}), title: title.slice(0, 500), hours: 1, type: a.kind, dates: { ...emptyDates(o.classes), [o.cls]: s.date }, homework: '', note: '', topicKey: null });
      return;
    }
    if (left > 0) {
      left--;
      return;
    }
    zeros(s.date);
    if (li >= lessons.length) return;
    const r = lessons[li++];
    out.push(dated(r, s.date));
    left = r.hours - 1;
  });
  for (; li < lessons.length; li++) out.push(dated(lessons[li], null));
  return out;
}

/** Sequential placement on the free slots: `keep` = dates that stay (mode `empty`). */
function place(rows: KtpRow[], slots: readonly StudySlot[], cls: string, keep: boolean): KtpRow[] {
  const used = new Array<boolean>(slots.length).fill(false);
  if (keep) {
    // A kept date takes `hours` slots of that day (as many as the day has).
    for (const r of rows) {
      const d = r.dates[cls] ?? null;
      if (!d) continue;
      let n = r.hours;
      for (let i = 0; i < slots.length && n > 0; i++) if (slots[i].date === d && !used[i]) (used[i] = true), n--;
    }
  }
  let cursor = 0; // the first slot a lesson without a date may take
  return rows.map((r) => {
    const d = keep ? (r.dates[cls] ?? null) : null;
    if (d) {
      // After a kept lesson, the next one starts at its day.
      const at = slots.findIndex((s) => s.date >= d);
      cursor = at < 0 ? slots.length : Math.max(cursor, at);
      return r;
    }
    while (cursor < slots.length && used[cursor]) cursor++;
    if (cursor >= slots.length) return { ...r, dates: { ...r.dates, [cls]: null } };
    const date = slots[cursor].date;
    for (let n = r.hours, i = cursor; n > 0 && i < slots.length; i++) if (!used[i]) (used[i] = true), n--;
    return { ...r, dates: { ...r.dates, [cls]: date } };
  });
}

/** The rows of a plan scheduled for one class (re-indexed; other classes' dates untouched). */
export function scheduleRows(rows: readonly KtpRow[], cal: SchoolCalendar, o: ScheduleOptions): KtpRow[] {
  const slots = studySlots(cal, o.weekdays, o.from);
  const numbered = rows.every((r, i) => r.number === i + 1);
  let next: KtpRow[];
  if (o.assessments && !rows.some((r) => r.type === 'soch')) {
    const planned = withAssessments(rows, slots, o);
    // `empty`: the lessons that had a date keep it; everything else is placed on the slots left.
    const before = new Map(rows.map((r) => [r.uid, r.dates[o.cls] ?? null]));
    next = o.mode === 'all' ? planned : place(planned.map((r) => ({ ...r, dates: { ...r.dates, [o.cls]: before.get(r.uid) ?? null } })), slots, o.cls, true);
  } else next = place(rows.map((r) => ({ ...r, dates: { ...r.dates } })), slots, o.cls, o.mode === 'empty');
  return next.map((r, i) => ({ ...r, index: i + 1, number: numbered || r.number === 0 ? i + 1 : r.number }));
}

/** The mark a preliminary КТП carries in its title (from-textbook / from-standard) — gone once it is scheduled. */
export const DRAFT_MARK = /\s*\((?:алдын ала|предварительн\S*|draft)\)/giu;
export const withoutDraftMark = (title: string) => title.replace(DRAFT_MARK, '').trim() || title;

/**
 * After scheduling the rows are the plan: the declared total and every section's hours follow them (a
 * section by its title, as the checks group it), so the plan raises no hours_mismatch / section_hours_mismatch.
 */
export function settleHours(rows: readonly KtpRow[]): { rows: KtpRow[]; declaredHours: number } {
  const bySection = new Map<string, number>();
  for (const r of rows) if (r.section) bySection.set(r.section.title, (bySection.get(r.section.title) ?? 0) + r.hours);
  return {
    rows: rows.map((r) => (r.section ? { ...r, section: { ...r.section, hours: bySection.get(r.section.title)! } } : r)),
    declaredHours: rows.reduce((n, r) => n + r.hours, 0),
  };
}
