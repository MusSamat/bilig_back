/**
 * v0.10.0: the school calendar — the study year, its quarters and holidays. The cabinet groups a КТП by
 * quarter, counts the hours a quarter needs and places lessons on the teacher's lesson days with it; the
 * server schedules a КТП with the same functions, so both sides agree on every date. Pure, UTC dates.
 */
import { z } from 'zod';

/** Calendar date `YYYY-MM-DD` (the same rule as `IsoDateSchema` of ktp.ts, which imports this module). */
const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const HolidaySchema = z.object({
  /** «Күзгү», «Кышкы» … */
  name: z.string().max(100),
  from: IsoDateSchema,
  to: IsoDateSchema,
});
export type Holiday = z.infer<typeof HolidaySchema>;

export const QuarterSchema = z.object({
  n: z.number().int().min(1).max(4),
  start: IsoDateSchema,
  end: IsoDateSchema,
});
export type Quarter = z.infer<typeof QuarterSchema>;

export const SchoolCalendarSchema = z.object({
  /** School year start (2026 = 2026–2027). */
  year: z.number().int().min(2000).max(2100),
  start: IsoDateSchema,
  end: IsoDateSchema,
  quarters: z.array(QuarterSchema).length(4),
  holidays: z.array(HolidaySchema),
});
export type SchoolCalendar = z.infer<typeof SchoolCalendarSchema>;

// GET /calendar?year=2026
export const CalendarQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

/** Lesson days of a class: ISO weekday (1 = Monday … 6 = Saturday) → lessons that day. */
export const WeekdaysSchema = z
  .record(
    z.enum(['1', '2', '3', '4', '5', '6']),
    z.number().int().min(1).max(4),
  )
  .refine((w) => Object.keys(w).length > 0, {
    message: 'At least one lesson day',
  });
export type Weekdays = z.infer<typeof WeekdaysSchema>;

/** The Ministry's calendars by year (Kyrgyzstan). Years without one use `defaultCalendar`. */
const KNOWN: Record<number, SchoolCalendar> = {
  2026: {
    year: 2026,
    start: '2026-09-02',
    end: '2027-05-25',
    quarters: [
      { n: 1, start: '2026-09-02', end: '2026-11-10' },
      { n: 2, start: '2026-11-16', end: '2026-12-31' },
      { n: 3, start: '2027-01-11', end: '2027-03-02' },
      { n: 4, start: '2027-03-09', end: '2027-05-25' },
    ],
    holidays: [
      { name: 'Күзгү', from: '2026-11-11', to: '2026-11-15' },
      { name: 'Кышкы', from: '2027-01-01', to: '2027-01-10' },
      { name: 'Жазгы', from: '2027-03-03', to: '2027-03-08' },
      { name: 'Майдагы', from: '2027-05-01', to: '2027-05-09' },
    ],
  },
};

const pad = (n: number) => String(n).padStart(2, '0');
export const isoOf = (d: Date) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const dateOf = (iso: string) => new Date(`${iso}T00:00:00Z`);
const addDays = (iso: string, n: number) => {
  const d = dateOf(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return isoOf(d);
};

/** A calendar shaped like the 2026 one for any year (holidays on the same dates). */
export function defaultCalendar(year: number): SchoolCalendar {
  const y = (offset: number, md: string) => `${year + offset}-${md}`;
  return {
    year,
    start: y(0, '09-02'),
    end: y(1, '05-25'),
    quarters: [
      { n: 1, start: y(0, '09-02'), end: y(0, '11-10') },
      { n: 2, start: y(0, '11-16'), end: y(0, '12-31') },
      { n: 3, start: y(1, '01-11'), end: y(1, '03-02') },
      { n: 4, start: y(1, '03-09'), end: y(1, '05-25') },
    ],
    holidays: [
      { name: 'Күзгү', from: y(0, '11-11'), to: y(0, '11-15') },
      { name: 'Кышкы', from: y(1, '01-01'), to: y(1, '01-10') },
      { name: 'Жазгы', from: y(1, '03-03'), to: y(1, '03-08') },
      { name: 'Майдагы', from: y(1, '05-01'), to: y(1, '05-09') },
    ],
  };
}

export const schoolCalendar = (year: number): SchoolCalendar =>
  KNOWN[year] ?? defaultCalendar(year);

/** The school year a date falls in (2026 for 1 Jul 2026 … 30 Jun 2027). */
export const schoolYearOfIso = (iso: string) => {
  const d = dateOf(iso);
  return d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
};

export const isHoliday = (cal: SchoolCalendar, iso: string) =>
  cal.holidays.some((h) => iso >= h.from && iso <= h.to);

/**
 * Quarter of a date: the quarter it falls in, or the next one for a date between quarters (a holiday);
 * null outside the year.
 */
export function quarterOf(
  cal: SchoolCalendar,
  iso: string | null | undefined,
): 1 | 2 | 3 | 4 | null {
  if (!iso || iso < cal.start || iso > cal.end) return null;
  const q = cal.quarters.find((x) => iso <= x.end);
  return (q?.n ?? null) as 1 | 2 | 3 | 4 | null;
}

/** ISO weekday 1..7 (Monday = 1). */
export const isoWeekday = (iso: string) =>
  ((dateOf(iso).getUTCDay() + 6) % 7) + 1;

export interface StudySlot {
  date: string;
  quarter: 1 | 2 | 3 | 4;
}

/**
 * Every lesson hour of a class in the year: the lesson days (a day with 2 lessons gives 2 slots), holidays
 * and days between quarters skipped. `from` starts later (a КТП made in October).
 */
export function studySlots(
  cal: SchoolCalendar,
  weekdays: Weekdays,
  from?: string,
): StudySlot[] {
  const out: StudySlot[] = [];
  for (
    let d = from && from > cal.start ? from : cal.start;
    d <= cal.end;
    d = addDays(d, 1)
  ) {
    const per = weekdays[String(isoWeekday(d)) as keyof Weekdays] ?? 0;
    if (!per || isHoliday(cal, d)) continue;
    const q = cal.quarters.find((x) => d >= x.start && d <= x.end);
    if (!q) continue;
    for (let i = 0; i < per; i++)
      out.push({ date: d, quarter: q.n as 1 | 2 | 3 | 4 });
  }
  return out;
}

/** Hours each quarter has for these lesson days: [q1, q2, q3, q4]. */
export function quarterHours(
  cal: SchoolCalendar,
  weekdays: Weekdays,
): [number, number, number, number] {
  const h: [number, number, number, number] = [0, 0, 0, 0];
  for (const s of studySlots(cal, weekdays)) h[s.quarter - 1]++;
  return h;
}
