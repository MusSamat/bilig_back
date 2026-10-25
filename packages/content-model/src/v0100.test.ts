import { describe, expect, it } from 'vitest';
import {
  AgendaResponseSchema,
  ENDPOINTS,
  KtpPatchRequestSchema,
  KtpRowSchema,
  LessonAssistRequestSchema,
  LessonContentPutSchema,
  emptyLessonGoals,
  quarterHours,
  quarterOf,
  schoolCalendar,
  studySlots,
  WeekdaysSchema,
} from './api/index.js';
import { contractAtLeast } from './i18n.js';
import { LESSON_MODELS, lessonModel, stageContentKey } from './lesson-models.js';

describe('contract 0.10.0', () => {
  it('compares versions by number', () => {
    expect(contractAtLeast('0.10.0')).toBe(true);
    expect(contractAtLeast('0.9.4')).toBe(true);
    expect(contractAtLeast('0.11.0')).toBe(false);
    expect(contractAtLeast('0.9.0', '0.10.0')).toBe(true);
  });

  it('has the four lesson models with 45-minute timings', () => {
    expect(LESSON_MODELS.map((m) => m.id)).toEqual(['5e', '3c1e', 'pemA', 'pemB']);
    for (const m of LESSON_MODELS) {
      expect(m.stages.reduce((a, s) => a + s.minutes, 0)).toBe(45);
      expect(new Set(m.stages.map((s) => s.key)).size).toBe(m.stages.length);
    }
    expect(lessonModel('nope').id).toBe('5e');
    expect(stageContentKey('pemA', 'predict')).toBe('pemA:predict');
  });

  it('knows the 2026–2027 calendar', () => {
    const cal = schoolCalendar(2026);
    expect(quarterOf(cal, '2026-10-23')).toBe(1);
    expect(quarterOf(cal, '2026-11-12')).toBe(2); // autumn holidays → the next quarter
    expect(quarterOf(cal, '2027-05-25')).toBe(4);
    expect(quarterOf(cal, '2027-06-01')).toBeNull();
    expect(schoolCalendar(2031).start).toBe('2031-09-02');
  });

  it('places lessons on lesson days and skips holidays', () => {
    const cal = schoolCalendar(2026);
    const slots = studySlots(cal, { '2': 1, '4': 1 });
    expect(slots[0]).toEqual({ date: '2026-09-03', quarter: 1 }); // Thu (2 Sep is a Wednesday)
    expect(slots.some((s) => s.date >= '2026-11-11' && s.date <= '2026-11-15')).toBe(false);
    const double = studySlots(cal, { '1': 2 });
    expect(double[0].date).toBe(double[1].date);
    const h = quarterHours(cal, { '2': 1, '4': 1 });
    expect(h.reduce((a, b) => a + b, 0)).toBe(slots.length);
    expect(WeekdaysSchema.safeParse({}).success).toBe(false);
    expect(WeekdaysSchema.safeParse({ '7': 1 }).success).toBe(false);
  });

  it('rows carry a stable uid; a patch can insert and remove', () => {
    const row = { uid: 'r_abc1', index: 1, number: 1, title: 'x', hours: 1, type: 'sor', dates: {}, homework: '', note: '', topicKey: null };
    expect(KtpRowSchema.safeParse(row).success).toBe(true);
    expect(KtpRowSchema.safeParse({ ...row, uid: undefined }).success).toBe(false);
    expect(KtpPatchRequestSchema.safeParse({ version: 1, remove: ['r_abc1'], insert: [{ afterUid: null, title: 'Жаңы' }] }).success).toBe(true);
  });

  it('validates lesson content and the assistant', () => {
    const body = {
      modelId: '5e',
      stages: { '5e:engage': { teacher: 'a', pupil: '', minutes: 5, attachments: ['m1'] } },
      goals: emptyLessonGoals(),
      materials: [{ id: 'm1', kind: 'examples', text: 'Мисал', on: true, source: 'teacher' }],
    };
    expect(LessonContentPutSchema.safeParse(body).success).toBe(true);
    expect(LessonContentPutSchema.safeParse({ ...body, stages: { bad: body.stages['5e:engage'] } }).success).toBe(false);
    expect(LessonAssistRequestSchema.safeParse({ task: 'materials', kind: 'stem', count: 2 }).success).toBe(true);
    expect(LessonAssistRequestSchema.safeParse({ task: 'ask', question: '' }).success).toBe(false);
  });

  it('routes the cabinet endpoints', () => {
    expect(ENDPOINTS.teacherAgenda.path).toBe('/teacher/agenda');
    expect(ENDPOINTS.lessonPut.ifMatchOptional).toBe(true);
    expect(ENDPOINTS.ktpSchedule.ifMatch).toBe(true);
    expect(AgendaResponseSchema.safeParse({ today: '2026-10-23', from: '2026-10-23', to: '2026-10-30', lessons: [], attention: [] }).success).toBe(true);
  });
});
