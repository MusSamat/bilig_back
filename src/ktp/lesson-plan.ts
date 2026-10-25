/**
 * v0.10.0: the «Сабактын планы» filled from a lesson page (pure). The plan built from the КТП row
 * (buildPlanContent) gives the header, sources and homework; the saved lesson content gives the stages of
 * its model (the teacher's and pupils' text, minutes, attached materials), the goals, and the ticked
 * materials as an appendix. Empty fields fall back to the model's hints and the generic goals.
 */
import type { Lang, LessonModel } from '@bilig/content-model';
import { stageContentKey, type LessonModelId } from '@bilig/content-model';
import type { KtpRow, LessonContentBody, LessonMaterial, LessonMaterialKind } from '@bilig/content-model/api';
import type { PlanContent, PlanStage } from './plan-content.js';
import { PLAN_TEXTS } from './plan-content.js';

interface LessonTexts {
  kinds: Record<LessonMaterialKind, string>;
  /** «• Мисал: …» before an attached material. */
  attached: Record<LessonMaterialKind, string>;
  appendix: string;
  assessTest: string;
  assessWatch: string;
  textbook: string;
  model3d: string;
  resources: string;
}

export const LESSON_TEXTS: Record<Lang, LessonTexts> = {
  ky: {
    kinds: { examples: 'Мисалдар', stem: 'STEM тапшырмалар', tests: 'Тест суроолору', slides: 'Презентациянын слайддары' },
    attached: { examples: 'Мисал', stem: 'STEM тапшырма', tests: 'Тест', slides: 'Слайд' },
    appendix: 'Тиркеме: сабактын материалдары',
    assessTest: 'Тест, рефлексия',
    assessWatch: 'Байкоо, суроо-жооп',
    textbook: 'Окуу китеби',
    model3d: '3D-модель',
    resources: 'Ресурстар',
  },
  ru: {
    kinds: { examples: 'Примеры', stem: 'STEM-задания', tests: 'Тестовые вопросы', slides: 'Слайды презентации' },
    attached: { examples: 'Пример', stem: 'STEM-задание', tests: 'Тест', slides: 'Слайд' },
    appendix: 'Приложение: материалы урока',
    assessTest: 'Тест, рефлексия',
    assessWatch: 'Наблюдение, вопрос-ответ',
    textbook: 'Учебник',
    model3d: '3D-модель',
    resources: 'Ресурсы',
  },
  en: {
    kinds: { examples: 'Examples', stem: 'STEM tasks', tests: 'Test questions', slides: 'Presentation slides' },
    attached: { examples: 'Example', stem: 'STEM task', tests: 'Test', slides: 'Slide' },
    appendix: 'Appendix: lesson materials',
    assessTest: 'Test, reflection',
    assessWatch: 'Observation, questions and answers',
    textbook: 'Textbook',
    model3d: '3D model',
    resources: 'Resources',
  },
};

const numbered = (lines: readonly string[]) => (lines.length > 1 ? lines.map((l, i) => `${i + 1}. ${l}`).join('\n') : (lines[0] ?? ''));

export interface LessonPlanInput {
  base: PlanContent;
  row: Pick<KtpRow, 'topicKey'>;
  body: LessonContentBody;
  model: LessonModel;
  lang: Lang;
}

/** The plan with the stages, goals and appendix of the saved lesson content. */
export function lessonPlanContent({ base, row, body, model, lang }: LessonPlanInput): PlanContent {
  const L = LESSON_TEXTS[lang];
  const T = PLAN_TEXTS[lang];
  const byId = new Map(body.materials.map((m) => [m.id, m]));
  const stages: PlanStage[] = model.stages.map((st, i) => {
    const c = body.stages[stageContentKey(model.id as LessonModelId, st.key)];
    const attached = (c?.attachments ?? []).map((id) => byId.get(id)).filter((m): m is LessonMaterial => !!m);
    const minutes = c?.minutes ?? st.minutes;
    const teacher = c?.teacher.trim() ? c.teacher.trim() : numbered(st.teacher);
    const kinds = [...new Set(attached.map((m) => m.kind))];
    const resources = [L.textbook, ...(row.topicKey ? [L.model3d] : []), ...kinds.map((k) => L.kinds[k])];
    const last = i === model.stages.length - 1;
    return {
      name: `${i + 1}. ${st.code} — ${st.title}`,
      minutes: T.minutes(minutes),
      teacher: [teacher, ...attached.map((m) => `• ${L.attached[m.kind]}: ${m.text}`), `${L.resources}: ${resources.join(', ')}`].join('\n'),
      student: c?.pupil.trim() ? c.pupil.trim() : st.pupil,
      kc: base.stages[Math.min(i, base.stages.length - 1)]?.kc ?? '',
      pk: base.stages[0]?.pk ?? '',
      assessment: last || kinds.includes('tests') ? L.assessTest : L.assessWatch,
    };
  });
  const totalMinutes = model.stages.reduce((n, st) => n + (body.stages[stageContentKey(model.id as LessonModelId, st.key)]?.minutes ?? st.minutes), 0);
  const g = body.goals;
  const ticked = body.materials.filter((m) => m.on);
  const groups = (Object.keys(L.kinds) as LessonMaterialKind[])
    .map((k) => ({ title: L.kinds[k], items: ticked.filter((m) => m.kind === k).map((m) => m.text) }))
    .filter((x) => x.items.length);
  return {
    ...base,
    goal1: g.knowledge.goal.trim() || base.goal1,
    outcome1: g.knowledge.result.trim() || base.outcome1,
    goal2: g.development.goal.trim() || base.goal2,
    outcome2: g.development.result.trim() || base.outcome2,
    goal3: g.upbringing.goal.trim() || base.goal3,
    outcome3: g.upbringing.result.trim() || base.outcome3,
    stages,
    totalMinutes,
    ...(groups.length ? { appendix: { title: L.appendix, groups } } : {}),
  };
}
