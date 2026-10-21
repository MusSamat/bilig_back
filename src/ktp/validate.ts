/**
 * КТП checks (pure). Issues carry a code, a severity, the lesson index, the
 * class and params; the client localizes the message. Runs on parse and again
 * after every PATCH (on the stored rows, never re-parsing the file).
 */
import type { KtpIssue, KtpRow } from '@bilig/content-model/api';
import type { InvalidDates } from './parse.js';

export interface ValidateMeta {
  classes: readonly string[];
  /** School year start; enables `date_out_of_year`. */
  year: number | null;
  declaredHours: number | null;
}

type Row = Pick<KtpRow, 'index' | 'title' | 'hours' | 'dates' | 'section'>;

/** Fixed-date public holidays of the Kyrgyz Republic (MM-DD). */
export const KG_HOLIDAYS: Record<string, string> = {
  '01-01': 'new_year',
  '01-07': 'christmas',
  '02-23': 'defender_day',
  '03-08': 'womens_day',
  '03-21': 'nooruz',
  '03-22': 'nooruz',
  '05-01': 'labour_day',
  '05-05': 'constitution_day',
  '05-09': 'victory_day',
  '08-31': 'independence_day',
  '11-07': 'history_day',
  '11-08': 'history_day',
};

const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

export const totalHours = (rows: readonly Pick<KtpRow, 'hours'>[]) => rows.reduce((s, r) => s + r.hours, 0);

export function validate(rows: readonly Row[], meta: ValidateMeta, invalidDates: InvalidDates = {}): KtpIssue[] {
  const issues: KtpIssue[] = [];
  if (!rows.length) {
    issues.push({ code: 'no_lessons', severity: 'error' });
    return issues;
  }

  const actual = totalHours(rows);
  if (meta.declaredHours !== null && meta.declaredHours !== actual)
    issues.push({ code: 'hours_mismatch', severity: 'warning', params: { declared: meta.declaredHours, actual } });

  const perRow = new Map<number, KtpIssue[]>();
  const add = (i: KtpIssue) => {
    const list = perRow.get(i.row ?? 0) ?? [];
    list.push(i);
    perRow.set(i.row ?? 0, list);
  };

  for (const r of rows) if (!r.title.trim()) add({ code: 'title_missing', severity: 'error', row: r.index });

  const from = meta.year !== null ? `${meta.year}-09-01` : null;
  const to = meta.year !== null ? `${meta.year + 1}-06-30` : null;
  for (const cls of meta.classes) {
    // v0.9.2: a column with no dates at all is a plan whose dates are still to be filled in (a КТП made
    // from a textbook): one note for the class, not an error per lesson.
    if (rows.every((r) => (r.dates[cls] ?? null) === null && !invalidDates[String(r.index)]?.[cls])) {
      issues.push({ code: 'date_missing', severity: 'info', class: cls });
      continue;
    }
    let prev: string | null = null;
    for (const r of rows) {
      const d = r.dates[cls] ?? null;
      if (d === null) {
        const raw = invalidDates[String(r.index)]?.[cls];
        if (raw) add({ code: 'date_invalid', severity: 'error', row: r.index, class: cls, params: { date: raw } });
        else add({ code: 'date_missing', severity: 'error', row: r.index, class: cls });
        continue;
      }
      if (prev !== null) {
        if (d < prev) add({ code: 'date_order', severity: 'error', row: r.index, class: cls, params: { date: d, prev } });
        else if (d === prev) add({ code: 'date_same_day', severity: 'info', row: r.index, class: cls, params: { date: d } });
      }
      if (weekday(d) === 0) add({ code: 'date_sunday', severity: 'warning', row: r.index, class: cls, params: { date: d } });
      const holiday = KG_HOLIDAYS[d.slice(5)];
      if (holiday) add({ code: 'date_holiday', severity: 'warning', row: r.index, class: cls, params: { date: d, holiday } });
      if (from && to && (d < from || d > to)) add({ code: 'date_out_of_year', severity: 'warning', row: r.index, class: cls, params: { date: d } });
      prev = d;
    }
  }

  // sections: declared hours vs the lessons under the heading
  const sections = new Map<string, { title: string; declared: number; actual: number; first: number }>();
  for (const r of rows) {
    if (!r.section || r.section.hours === undefined) continue;
    const key = `${r.section.title}\u0000${r.section.hours}`;
    const s = sections.get(key) ?? { title: r.section.title, declared: r.section.hours, actual: 0, first: r.index };
    s.actual += r.hours;
    sections.set(key, s);
  }
  for (const s of sections.values())
    if (s.declared !== s.actual)
      add({ code: 'section_hours_mismatch', severity: 'warning', row: s.first, params: { section: s.title, declared: s.declared, actual: s.actual } });

  for (const idx of [...perRow.keys()].sort((a, b) => a - b)) issues.push(...perRow.get(idx)!);
  return issues;
}
