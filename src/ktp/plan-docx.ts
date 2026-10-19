/**
 * Lesson plan .docx from the tagged official form (assets/templates/lesson-plan.docx,
 * provenance in assets/templates/README.md) with docxtemplater. The form's
 * own labels are tags too ({L.subject} …), filled from the ky/ru/en
 * dictionary below, so every language comes from the same template. The body
 * is a loop over plans with a page break between them: one plan or a range
 * renders through the same path.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import type { Lang } from '@bilig/content-model';
import type { PlanContent } from './plan-content.js';

export const LESSON_PLAN_TEMPLATE = fileURLToPath(new URL('../../assets/templates/lesson-plan.docx', import.meta.url));

export interface PlanLabels {
  classWord: string;
  date: string;
  teacher: string;
  subject: string;
  lessonType: string;
  topic: string;
  methods: string;
  target: string;
  task: string;
  materials: string;
  goals: string;
  outcomes: string;
  goalEdu: string;
  goalDev: string;
  goalUp: string;
  keyComp: string;
  subjComp: string;
  kc1: string;
  kc2: string;
  kc3: string;
  kcCode: string;
  flow: string;
  stage: string;
  time: string;
  teacherActs: string;
  studentActs: string;
  competences: string;
  assessment: string;
  kcShort: string;
  pkShort: string;
  sources: string;
}

export const PLAN_LABELS: Record<Lang, PlanLabels> = {
  ky: {
    classWord: '-класс',
    date: 'Числосу',
    teacher: 'Мугалими',
    subject: 'Предмети',
    lessonType: 'Сабактын тиби',
    topic: 'Сабактын темасы',
    methods: 'Сабактагы колдонулуучу усулдар жана ыкмалар',
    target: 'Сабактын максаттуу тобу',
    task: 'Сабактын милдети',
    materials: 'Сабакта колдонулуучу каражаттар жана материалдар',
    goals: 'Сабактын максаттары',
    outcomes: 'Күтүлүүчү натыйжалар',
    goalEdu: 'Билим берүүчүлүк',
    goalDev: 'Өнүктүрүүчүлүк',
    goalUp: 'Тарбиялык',
    keyComp: 'Негизги компетенттүүлүктөр',
    subjComp: 'Предметтик компетенттүүлүктөр',
    kc1: 'Маалыматтык компетенттүүлүк',
    kc2: 'Социалдык-коммуникативдик компетенттүүлүк',
    kc3: '“Өзүн-өзү уюштуруу жана көйгөйлөрдү чечүү”',
    kcCode: 'НК',
    flow: 'Сабактын жүрүшү',
    stage: 'Сабактын этаптары',
    time: 'Убакыт\n(мүнөтү)',
    teacherActs: 'Мугалимдин иш аракети',
    studentActs: 'Окуучулардын иш аракети',
    competences: 'Окуучу калыптандыруучу компетенттүүлүктөр',
    assessment: 'Баалоо\nФормативдик\nСуммативдик\nЖыйынтыктоочу',
    kcShort: 'Негизги',
    pkShort: 'Пред',
    sources: 'Колдонулган булактар',
  },
  ru: {
    classWord: 'класс',
    date: 'Дата',
    teacher: 'Учитель',
    subject: 'Предмет',
    lessonType: 'Тип урока',
    topic: 'Тема урока',
    methods: 'Методы и приёмы, используемые на уроке',
    target: 'Целевая группа урока',
    task: 'Задача урока',
    materials: 'Средства и материалы урока',
    goals: 'Цели урока',
    outcomes: 'Ожидаемые результаты',
    goalEdu: 'Образовательная',
    goalDev: 'Развивающая',
    goalUp: 'Воспитательная',
    keyComp: 'Ключевые компетентности',
    subjComp: 'Предметные компетентности',
    kc1: 'Информационная компетентность',
    kc2: 'Социально-коммуникативная компетентность',
    kc3: '«Самоорганизация и разрешение проблем»',
    kcCode: 'КК',
    flow: 'Ход урока',
    stage: 'Этапы урока',
    time: 'Время\n(мин)',
    teacherActs: 'Деятельность учителя',
    studentActs: 'Деятельность учащихся',
    competences: 'Формируемые компетентности',
    assessment: 'Оценивание\nформативное\nсуммативное\nитоговое',
    kcShort: 'Ключ.',
    pkShort: 'Предм.',
    sources: 'Использованные источники',
  },
  en: {
    classWord: 'class',
    date: 'Date',
    teacher: 'Teacher',
    subject: 'Subject',
    lessonType: 'Lesson type',
    topic: 'Lesson topic',
    methods: 'Methods and techniques',
    target: 'Target group',
    task: 'Lesson task',
    materials: 'Resources and materials',
    goals: 'Lesson goals',
    outcomes: 'Expected outcomes',
    goalEdu: 'Educational',
    goalDev: 'Developmental',
    goalUp: 'Personal and social',
    keyComp: 'Key competences',
    subjComp: 'Subject competences',
    kc1: 'Information competence',
    kc2: 'Social and communicative competence',
    kc3: '“Self-organisation and problem solving”',
    kcCode: 'KC',
    flow: 'Lesson procedure',
    stage: 'Lesson stages',
    time: 'Time\n(min)',
    teacherActs: 'Teacher’s activity',
    studentActs: 'Students’ activity',
    competences: 'Competences developed',
    assessment: 'Assessment\nformative\nsummative\nfinal',
    kcShort: 'Key',
    pkShort: 'Subj.',
    sources: 'Sources',
  },
};

const PAGE_BREAK = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

let templateBytes: Buffer | null = null;
const template = () => (templateBytes ??= readFileSync(LESSON_PLAN_TEMPLATE));

/** `{L.subject}` → scope.L.subject; `{.}` → the loop item. Lookups fall through to outer scopes. */
const parser = (tag: string) => ({
  get(scope: unknown): unknown {
    if (tag === '.') return scope;
    let v: unknown = scope;
    for (const k of tag.split('.')) {
      if (v === null || typeof v !== 'object') return undefined;
      v = (v as Record<string, unknown>)[k];
    }
    return v;
  },
});

/** One .docx with a plan per page. */
export function renderPlansDocx(plans: readonly PlanContent[]): Buffer {
  if (!plans.length) throw new Error('renderPlansDocx: no plans');
  const doc = new Docxtemplater(new PizZip(template()), {
    paragraphLoop: true,
    linebreaks: true,
    parser,
    nullGetter: () => '',
  });
  doc.render({
    plans: plans.map((p, i) => ({ ...p, L: PLAN_LABELS[p.lang], pageBreak: i < plans.length - 1 ? PAGE_BREAK : '' })),
  });
  return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
}
