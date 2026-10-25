/** v0.10.0: scheduling a КТП class column on the lesson days (pure). */
import { describe, expect, it } from 'vitest';
import { isHoliday, quarterHours, schoolCalendar, studySlots, type KtpRow } from '@bilig/content-model/api';
import { assessmentSlots, scheduleRows } from '../schedule.js';
import { lessonType } from '../lesson-type.js';
import { validate } from '../validate.js';

const cal = schoolCalendar(2026);
const row = (i: number, extra: Partial<KtpRow> = {}): KtpRow => ({
  uid: `r_row${i}`,
  index: i,
  number: i,
  section: { title: i <= 5 ? 'Кинематика' : 'Динамика' },
  title: `Сабак ${i}`,
  hours: 1,
  type: 'new',
  dates: { '7А': null, '7Б': '2026-09-03' },
  homework: '',
  note: '',
  topicKey: null,
  ...extra,
});
const rows = (n: number) => Array.from({ length: n }, (_, k) => row(k + 1));
const opts = { cls: '7А', classes: ['7А', '7Б'], lang: 'ky' as const };
const MON_WED = { '1': 1, '3': 1 } as const;

describe('scheduleRows', () => {
  it('all: one slot per lesson hour on the lesson days, holidays skipped; other classes untouched', () => {
    const out = scheduleRows(rows(30), cal, { ...opts, weekdays: MON_WED, mode: 'all' });
    const slots = studySlots(cal, MON_WED);
    expect(out.map((r) => r.dates['7А'])).toEqual(slots.slice(0, 30).map((s) => s.date));
    expect(out[0].dates['7А']).toBe('2026-09-02'); // Wednesday, the first day
    expect(out.every((r) => !isHoliday(cal, r.dates['7А']!))).toBe(true);
    expect(out.every((r) => r.dates['7Б'] === '2026-09-03')).toBe(true);
    // Autumn holidays 11–15 Nov: Wednesday 11 Nov is not a lesson day.
    expect(out.map((r) => r.dates['7А'])).not.toContain('2026-11-11');
  });

  it('a double lesson takes two slots of the day; 0 hours rides on the next slot; beyond the year → no date', () => {
    const double = { '2': 2 } as const; // Tuesdays, two lessons
    const out = scheduleRows([row(1, { hours: 2 }), row(2, { hours: 0 }), row(3), row(4)], cal, { ...opts, weekdays: double, mode: 'all' });
    expect(out.map((r) => r.dates['7А'])).toEqual(['2026-09-08', '2026-09-15', '2026-09-15', '2026-09-15']);
    const many = scheduleRows(rows(200), cal, { ...opts, weekdays: { '5': 1 }, mode: 'all' });
    const n = studySlots(cal, { '5': 1 }).length;
    expect(many.filter((r) => r.dates['7А'])).toHaveLength(n);
    expect(many.at(-1)!.dates['7А']).toBeNull();
  });

  it('empty: dated lessons keep their dates and slots; the others take the free slots after the lesson before', () => {
    const input = rows(6);
    input[1].dates['7А'] = '2026-09-07'; // Monday — the 2nd slot
    input[3].dates['7А'] = '2026-09-21'; // a later Monday
    const out = scheduleRows(input, cal, { ...opts, weekdays: MON_WED, mode: 'empty' });
    expect(out.map((r) => r.dates['7А'])).toEqual(['2026-09-02', '2026-09-07', '2026-09-09', '2026-09-21', '2026-09-23', '2026-09-28']);
    // A day with two slots: the kept lesson takes one, the next lesson the other.
    const two = rows(3);
    two[0].dates['7А'] = '2026-09-08';
    expect(scheduleRows(two, cal, { ...opts, weekdays: { '2': 2 }, mode: 'empty' }).map((r) => r.dates['7А'])).toEqual(['2026-09-08', '2026-09-08', '2026-09-15']);
    // all: re-placed from the start
    expect(scheduleRows(input, cal, { ...opts, weekdays: MON_WED, mode: 'all' })[1].dates['7А']).toBe('2026-09-07');
    expect(scheduleRows(input, cal, { ...opts, weekdays: MON_WED, mode: 'all' })[3].dates['7А']).toBe('2026-09-14');
  });

  it('assessments: a СОЧ at the end of every quarter, two СОР in long quarters, big topics split, review lessons', () => {
    const slots = studySlots(cal, MON_WED);
    const reserved = assessmentSlots(slots);
    const q = quarterHours(cal, MON_WED);
    expect([...reserved.values()].filter((a) => a.kind === 'soch')).toHaveLength(4);
    expect([...reserved.values()].filter((a) => a.kind === 'sor')).toHaveLength(2 * q.filter((n) => n > 8).length);
    const input = rows(40);
    const out = scheduleRows(input, cal, { ...opts, weekdays: MON_WED, mode: 'all', assessments: true });
    // every slot is used exactly once, in order
    expect(out.map((r) => r.dates['7А'])).toEqual(slots.map((s) => s.date));
    expect(out.map((r) => r.index)).toEqual(out.map((_, i) => i + 1));
    const soch = out.filter((r) => r.type === 'soch');
    expect(soch.map((r) => r.title)).toEqual(['1-чейрек боюнча СОЧ', '2-чейрек боюнча СОЧ', '3-чейрек боюнча СОЧ', '4-чейрек боюнча СОЧ']);
    expect(soch[0].dates['7А']).toBe(slots.filter((s) => s.quarter === 1).at(-1)!.date);
    const sor = out.filter((r) => r.type === 'sor');
    expect(sor[0].title).toMatch(/^СОР №1\. (Кинематика|Динамика)$/);
    // 40 lessons < free slots: new lessons in two parts, the rest review lessons
    const free = slots.length - reserved.size;
    const parts = out.filter((r) => r.title.endsWith('(2-бөлүк)'));
    expect(parts).toHaveLength(Math.min(40, free - 40));
    expect(out.filter((r) => r.title === 'Кайталоо жана жалпылоо')).toHaveLength(Math.max(0, free - 80));
    // the original rows keep their uids (lesson content stays with them)
    for (const r of input) expect(out.some((x) => x.uid === r.uid)).toBe(true);
    expect(new Set(out.map((r) => r.uid)).size).toBe(out.length);
    // scheduling again adds no second set of assessments
    const again = scheduleRows(out, cal, { ...opts, weekdays: MON_WED, mode: 'all', assessments: true });
    expect(again.filter((r) => r.type === 'soch')).toHaveLength(4);
  });

  it('assessments in ru; empty mode keeps the dates there are', () => {
    const input = rows(10);
    input[0].dates['7А'] = '2026-09-07';
    const out = scheduleRows(input, cal, { ...opts, lang: 'ru', weekdays: { '4': 1 }, mode: 'empty', assessments: true });
    expect(out.find((r) => r.uid === 'r_row1')!.dates['7А']).toBe('2026-09-07');
    expect(out.filter((r) => r.type === 'soch')[0].title).toBe('СОЧ за 1 четверть');
    expect(out.some((r) => r.title.endsWith('(часть 2)'))).toBe(true);
    const dated = out.map((r) => r.dates['7А']).filter(Boolean);
    expect(new Set(dated.filter((d) => d !== '2026-09-07')).size).toBe(dated.length - 1);
  });
});

describe('СОР / СОЧ lesson types', () => {
  it('recognised before the generic test rule (ky, ru)', () => {
    expect(lessonType('СОР №2. Кинематика')).toBe('sor');
    expect(lessonType('Суммативное оценивание за раздел «Движение»')).toBe('sor');
    expect(lessonType('Бөлүм боюнча суммативдик баалоо')).toBe('sor');
    expect(lessonType('СОЧ за 1 четверть')).toBe('soch');
    expect(lessonType('Суммативное оценивание за четверть')).toBe('soch');
    expect(lessonType('1-чейрек боюнча суммативдик баалоо')).toBe('soch');
    expect(lessonType('Контрольная работа №1')).toBe('test');
    expect(lessonType('Анализ СОР')).toBe('analysis');
  });
});

describe('quarter_hours_short', () => {
  it('a warning per quarter with fewer planned hours than the lesson days give', () => {
    const scheduled = scheduleRows(rows(15), cal, { ...opts, weekdays: MON_WED, mode: 'all' });
    const need = quarterHours(cal, MON_WED);
    const issues = validate(scheduled, { classes: ['7А'], year: 2026, declaredHours: null, schedule: { '7А': MON_WED } }).filter((i) => i.code === 'quarter_hours_short');
    expect(issues.map((i) => i.params!.quarter)).toEqual([1, 2, 3, 4].filter((q) => (q === 1 ? 15 : 0) < need[q - 1]));
    expect(issues[0]).toEqual({ code: 'quarter_hours_short', severity: 'warning', class: '7А', params: { quarter: 1, planned: 15, need: need[0], class: '7А' } });
    // without a schedule (or a year): no check
    expect(validate(scheduled, { classes: ['7А'], year: 2026, declaredHours: null }).some((i) => i.code === 'quarter_hours_short')).toBe(false);
    expect(validate(scheduled, { classes: ['7А'], year: null, declaredHours: null, schedule: { '7А': MON_WED } }).some((i) => i.code === 'quarter_hours_short')).toBe(false);
  });
});
