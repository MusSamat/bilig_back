/**
 * Content of one official 45-minute lesson plan (сабак планы) for a КТП
 * lesson and class, in ky / ru / en. Pure.
 *
 * With a linked topic the plan is built from its package in the plan
 * language: goal → lesson task and educational goal, objectives → expected
 * outcomes, a simple example → the motivation question, the first tour steps
 * (with the teacher notes as hints) → new material, a process or the
 * comparison → practical work, single/multiple quiz items → the mini-test,
 * the textbook place → sources and homework. Without a topic it is a
 * rule-based draft. Every plan ends with the draft note; ПК codes are left
 * for the teacher.
 */
import { placesOfTopic, t, topicConcepts, type ContentPackage, type Lang, type Textbook } from '@bilig/content-model';
import type { KtpLessonType, KtpRow } from '@bilig/content-model/api';

export const STAGE_COUNT = 7;

/** Minutes per stage for each lesson type; each row totals 45. */
export const STAGE_TIMES: Record<KtpLessonType, readonly number[]> = {
  new: [3, 5, 2, 10, 10, 10, 5],
  practice: [3, 7, 2, 5, 3, 20, 5],
  test: [3, 2, 2, 3, 30, 3, 2],
  analysis: [3, 3, 2, 10, 5, 17, 5],
  // v0.10.0: СОР / СОЧ are summative tests — the timings of `test`.
  sor: [3, 2, 2, 3, 30, 3, 2],
  soch: [3, 2, 2, 3, 30, 3, 2],
};
for (const [k, v] of Object.entries(STAGE_TIMES)) {
  const sum = v.reduce((a, b) => a + b, 0);
  if (v.length !== STAGE_COUNT || sum !== 45) throw new Error(`STAGE_TIMES.${k} must be 7 stages totalling 45 minutes (got ${sum})`);
}

/** Key competences (НК) formed at each stage. */
const KC: readonly number[][] = [[3], [1, 2], [1], [1, 3], [1, 2, 3], [1, 2, 3], [1, 2, 3]];

export interface PlanStage {
  name: string;
  minutes: string;
  teacher: string;
  student: string;
  kc: string;
  pk: string;
  assessment: string;
}

export interface PlanContent {
  lang: Lang;
  classLabel: string;
  date: string;
  teacher: string;
  subject: string;
  lessonType: string;
  topic: string;
  methods: string;
  target: string;
  task: string;
  materials: string;
  goal1: string;
  outcome1: string;
  goal2: string;
  outcome2: string;
  goal3: string;
  outcome3: string;
  pk1: string;
  pk2: string;
  pk3: string;
  stages: PlanStage[];
  sources: string[];
  homework: string;
  draftNote: string;
  /** Total of the stage minutes (always 45; v0.10.0: a lesson model's stages may differ). */
  totalMinutes: number;
  /** v0.10.0: the lesson's ticked materials, printed after the plan («Тиркеме»). */
  appendix?: { title: string; groups: { title: string; items: string[] }[] };
}

export interface PlanInput {
  plan: { subjectName: string; subjectKey: string | null; grade: number | null; teacherName: string };
  row: KtpRow;
  /** The lesson before this one (stage 2 recalls it). */
  prev?: KtpRow | null;
  cls: string;
  lang: Lang;
  /** Package of the linked topic (published) and the textbooks for «§ … стр.». */
  topic?: { pkg: ContentPackage; textbooks: readonly Textbook[] } | null;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const cap = (s: string) => (s ? s[0].toLocaleUpperCase('ru') + s.slice(1) : s);
const firstSentence = (s: string) => {
  const m = /^(.+?[.!?])(\s|$)/su.exec(s.trim());
  return (m ? m[1] : s).trim();
};
const shorten = (s: string, n = 180) => {
  const one = s.replace(/\s+/g, ' ').trim();
  if (one.length <= n) return one;
  const cut = one.slice(0, n);
  const sp = cut.lastIndexOf(' ');
  return `${cut.slice(0, sp > n * 0.6 ? sp : n).replace(/[,;:–—-]+$/, '')}…`;
};
const numbered = (lines: readonly string[]) => lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
const fmtDate = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '');
const NATURAL = new Set(['phys', 'chem', 'bio', 'geo', 'astro']);

/** Grade of a class label («8б» → 8), else the plan grade. */
export function gradeOf(cls: string, fallback: number | null): number | null {
  const m = /^(\d{1,2})/.exec(cls);
  const g = m ? Number(m[1]) : fallback;
  return g !== null && g >= 1 && g <= 12 ? g : null;
}

// ---------------------------------------------------------------------------
// texts
// ---------------------------------------------------------------------------

interface Texts {
  stages: readonly string[];
  minutes: (n: number) => string;
  kc: string;
  pkPlaceholder: string;
  pkChoose: (n: number) => string;
  types: Record<KtpLessonType, string>;
  teacherBlank: string;
  dateBlank: string;
  instruction: string;
  target: (cls: string, grade: number | null) => string;
  methods: (type: KtpLessonType, subject: string | null, linked: boolean) => string;
  materials: (linkedTitle: string | null) => string;
  task: (title: string) => string;
  goalEdu: (title: string) => string;
  outcomeEdu: (title: string) => string;
  outcomeFrom: (objectives: string[]) => string;
  /** Test / analysis lessons: what is checked («Бөлчөктөр» section, or the subject). */
  taskTest: (scope: string) => string;
  outcomeTest: string;
  taskAnalysis: (scope: string) => string;
  outcomeAnalysis: string;
  goalDev: (subject: string | null) => string;
  outcomeDev: string;
  goalUp: string;
  outcomeUp: string;
  // stages
  organise: string;
  motivate: string;
  motivateFrom: (title: string, text: string) => string;
  studentsReady: string;
  recall: (prevTitle: string | null) => string;
  studentsRecall: string;
  announce: string[];
  studentsAnnounce: string;
  explain: (title: string) => string[];
  hint: (s: string) => string;
  studentsNew: string;
  studentsModel: (concepts: string) => string;
  practice: string;
  practiceProcess: (title: string, io: string) => string;
  practiceCompare: (cols: string, rows: string) => string;
  studentsPractice: string;
  consolidate: string;
  consolidateExample: (title: string, text: string) => string;
  studentsConsolidate: string;
  miniTest: string;
  miniTestFrom: (stems: string[]) => string;
  wrapUp: string;
  homeworkLine: (hw: string) => string;
  studentsWrap: string;
  // lesson-type variants
  practiceRules: (title: string) => string;
  practiceProblems: (title: string) => string;
  studentsProblems: string;
  testRules: string;
  studentsTestRules: string;
  testRun: (biligTest: string | null) => string;
  studentsTest: string;
  testCollect: string;
  studentsHandIn: string;
  testWrap: string;
  studentsTestWrap: string;
  analysisReview: string;
  studentsAnalysis: string;
  analysisFix: string;
  studentsFix: string;
  formative: string;
  summative: string;
  // sources & homework
  textbookPlace: (book: string, number: string, pages: { from: number; to: number } | undefined) => string;
  subjectBook: (subject: string, grade: number | null) => string;
  biligTopic: (title: string) => string;
  bilig: string;
  homeworkRead: (number: string, pages: { from: number; to: number } | undefined) => string;
  homeworkDefault: string;
  homeworkTest: string;
  draftNote: string;
}

const pagesKy = (p?: { from: number; to: number }) => (p ? `, ${p.from}–${p.to}-беттер` : '');
const pagesRu = (p?: { from: number; to: number }) => (p ? `, стр. ${p.from}–${p.to}` : '');
const pagesEn = (p?: { from: number; to: number }) => (p ? `, pp. ${p.from}–${p.to}` : '');

const KY: Texts = {
  stages: [
    '1. Уюштуруу.\nШыктандыруу',
    '2. Өткөн сабакты бышыктоо',
    '3. Теманы жана күтүлгөн окуу натыйжаларын жарыялоо',
    '4. Тема боюнча зарыл болгон маалыматтарды берүү',
    '5. Практикалык иш',
    '6. Бышыктоо',
    '7. Сабактын жыйынтыктарын чыгаруу; натыйжаларын баалоо',
  ],
  minutes: (n) => `${n} мүнөт`,
  kc: 'НК',
  pkPlaceholder: 'ПК __',
  pkChoose: (n) => `ПК ${n} — программадан тандаңыз`,
  types: {
    new: 'Жаңы билимдерди өздөштүрүү, бышыктоо',
    practice: 'Билимдерди бышыктоо, көндүмдөрдү калыптандыруу',
    test: 'Билимдерди текшерүү',
    analysis: 'Текшерүү ишин талдоо, каталар менен иштөө',
    sor: 'Бөлүм боюнча суммативдик баалоо (СОР)',
    soch: 'Чейрек боюнча суммативдик баалоо (СОЧ)',
  },
  teacherBlank: '______________________',
  dateBlank: '_________________',
  instruction: 'кыргыз',
  target: (_cls, g) =>
    g !== null ? `(${g + 5}-${g + 6} жаш курагындагы окуучулар үчүн, ${g}-класс, окутуу тили – кыргыз тилинде)` : '(окутуу тили – кыргыз тилинде)',
  methods: (type, subject, linked) => {
    const base =
      type === 'test'
        ? ['өз алдынча жазуу иши', 'баалоо критерийлери менен иштөө']
        : type === 'analysis'
          ? ['каталар менен иштөө', 'жуптар менен иштөө', 'суроо-жооп']
          : type === 'practice'
            ? ['деңгээл боюнча тапшырмалар', 'жуптар жана топтор менен иштөө', subject === 'math' ? 'мисал иштөө' : 'маселе чыгаруу']
            : ['түшүндүрүү', 'суроо-жооп', 'топтор менен иштөө', ...(subject === 'math' ? ['мисал иштөө'] : [])];
    if (linked && type !== 'test') base.push('Bilig 3D модели менен көрсөтүү');
    return base.join(', ');
  },
  materials: (lt) => ['окуу китеби', 'компьютер', 'проектор же интерактивдүү панель', ...(lt ? [`Bilig: «${lt}»`] : [])].join(', '),
  task: (title) => `«${title}» темасы боюнча билим, көндүм жана компетенцияларды калыптандыруу`,
  goalEdu: (title) => `Окуучулар «${title}» темасынын негизги түшүнүктөрүн жана ыкмаларын үйрөнүшөт.`,
  outcomeEdu: (title) => `Окуучулар «${title}» темасы боюнча билимин түшүндүрүп, колдоно алса;`,
  outcomeFrom: (o) => `Окуучулар төмөнкүлөрдү аткара алса:\n${o.map((x) => `– ${x}`).join('\n')}`,
  taskTest: (sc) => `«${sc}» боюнча окуучулардын билимин жана көндүмдөрүн текшерүү.`,
  outcomeTest: 'Окуучулар тапшырмаларды өз алдынча аткарып, билимин көрсөтө алса;',
  taskAnalysis: (sc) => `«${sc}» боюнча текшерүү ишинин жыйынтыгын талдоо, каталарды оңдоо.`,
  outcomeAnalysis: 'Окуучулар өз каталарын таап, туура чыгарылышын түшүндүрө алса;',
  goalDev: (s) =>
    s === 'math'
      ? 'Окуучулар логикалык ой жүгүртүүсүн, эсептөө жана далилдөө көндүмдөрүн өнүктүрүшөт.'
      : s && NATURAL.has(s)
        ? 'Окуучулар байкоо жүргүзүү, тажрыйба жасоо жана жыйынтык чыгаруу көндүмдөрүн өнүктүрүшөт.'
        : 'Окуучулар ой жүгүртүүсүн, талдоо жана өз оюн айтуу көндүмдөрүн өнүктүрүшөт.',
  outcomeDev: 'Окуучулар тапшырмаларды өз алдынча аткарып, жообун негиздей алса;',
  goalUp: 'Окуучулар топто иштөөгө, бири-биринин оюн угууга жана урматтоого тарбияланышат.',
  outcomeUp: 'Окуучулар топто макулдашып иштеп, бири-биринин ишин адилет баалай алса.',
  organise: 'Сабакты уюштуруу, саламдашуу, окуучуларды текшерүү.',
  motivate: 'Шыктандыруу: темага байланышкан кыска суроо же жашоодон мисал коюлат.',
  motivateFrom: (title, text) => `Шыктандыруу: «${title}» — ${text} Суроо: бул бүгүнкү темага кандай байланыштуу?`,
  studentsReady: 'Сабакка даярданып, суроого өз оюн айтышат.',
  recall: (p) => (p ? `Өткөн тема «${p}» боюнча кыска суроо-жооп уюштурулат.` : 'Өткөн теманын негизги түшүнүктөрү боюнча кыска суроо-жооп уюштурулат.'),
  studentsRecall: 'Суроолорго жооп берип, мурунку билимин эске түшүрүшөт.',
  announce: ['Сабактын темасы жана максаттары көрсөтүлөт.', 'Күтүлгөн натыйжалар жана сабактын жүрүшү кыскача түшүндүрүлөт.'],
  studentsAnnounce: 'Максаттарды окуп, өз күтүүлөрүн айтышат.',
  explain: (title) => [`«${title}» темасы боюнча негизги түшүнүктөр, аныктамалар жана мисалдар түшүндүрүлөт.`, 'Окуу китебиндеги материал менен иштөө уюштурулат.'],
  hint: (s) => `Кеңеш: ${s}`,
  studentsNew: 'Жаңы маалыматты кабыл алып, негизги түшүнүктөрдү дептерге жазышат.',
  studentsModel: (c) => `Bilig 3D моделинде ${c} карашат, негизги түшүнүктөрдү дептерге жазышат.`,
  practice: 'Топторго практикалык тапшырма берилет, аткарылышы көзөмөлдөнөт.',
  practiceProcess: (title, io) => `Практикалык иш: «${title}»${io ? ` (${io})` : ''}. Топтор кадамдарды аткарып, жыйынтыгын жазышат.`,
  practiceCompare: (cols, rows) => `Салыштыруу таблицасы: ${cols}${rows ? ` (${rows})` : ''}. Топтор таблицаны толтурушат.`,
  studentsPractice: 'Тапшырманы топто аткарып, жыйынтыгын талкуулашат.',
  consolidate: 'Бышыктоо үчүн тапшырмалар берилет, топтордун иши көзөмөлдөнөт.',
  consolidateExample: (title, text) => `Турмуштук мисал: «${title}» — ${text}`,
  studentsConsolidate: 'Тапшырмаларды аткарып, жоопторун текшеришет.',
  miniTest: 'Кыска мини-тест өткөрүлөт.',
  miniTestFrom: (s) => `Мини-тест:\n${s.map((x, i) => `${'абв'[i]}) ${x}`).join('\n')}`,
  wrapUp: 'Сабактын жыйынтыгы чыгарылат, окуучулардын иши бааланат.',
  homeworkLine: (hw) => `Үй тапшырмасы: ${hw}`,
  studentsWrap: 'Мини-тестке жооп беришет, өз ишин баалашат, үй тапшырмасын жазып алышат.',
  practiceRules: (title) => `«${title}» темасы боюнча негизги эрежелер жана формулалар кыскача эскертилет.`,
  practiceProblems: (title) => `«${title}» боюнча мисалдар, маселелер чыгарылат (деңгээл боюнча бөлүнгөн тапшырмалар).`,
  studentsProblems: 'Мисалдарды өз алдынча жана жуптарда чыгарып, жоопторун текшеришет.',
  testRules: 'Текшерүү ишинин шарттары жана баалоо критерийлери түшүндүрүлөт.',
  studentsTestRules: 'Шарттарды угуп, суроолорун беришет.',
  testRun: (b) => `Текшерүү иши (варианттар боюнча) таратылат, убакыт көзөмөлдөнөт.${b ? ` Кошумча: Bilig тести «${b}».` : ''}`,
  studentsTest: 'Текшерүү ишин өз алдынча аткарышат.',
  testCollect: 'Иштер чогултулат.',
  studentsHandIn: 'Иштерин тапшырышат.',
  testWrap: 'Сабак жыйынтыкталат, кийинки сабакта иштин талдоосу болору айтылат.',
  studentsTestWrap: 'Иштин кайсы бөлүгү кыйын болгонун айтышат.',
  analysisReview: 'Текшерүү ишинин жыйынтыгы, көп кетирилген каталар талдоого алынат.',
  studentsAnalysis: 'Өз каталарын табышат, себебин түшүнүшөт.',
  analysisFix: 'Каталар боюнча окшош тапшырмалар кайра чыгарылат.',
  studentsFix: 'Каталарын оңдошуп, окшош тапшырмаларды аткарышат.',
  formative: 'Формативдик баа.',
  summative: 'Суммативдик баа.',
  textbookPlace: (b, n, p) => `${b}${n ? `, § ${n}` : ''}${pagesKy(p)}`,
  subjectBook: (s, g) => `${cap(s)} окуу китеби${g !== null ? ` (${g}-класс)` : ''}`,
  biligTopic: (title) => `Bilig платформасы: «${title}» (3D модель, тур, тест)`,
  bilig: 'Bilig платформасы',
  homeworkRead: (n, p) => `§ ${n} окуу${pagesKy(p)}`,
  homeworkDefault: 'Өтүлгөн теманы кайталоо, дептердеги тапшырмаларды бүтүрүү.',
  homeworkTest: 'Үй тапшырмасы берилбейт.',
  draftNote: '[Долбоор Bilig тарабынан автоматтык түрдө түзүлдү — мугалим текшерип, ПК кодун тандап, түзөтүшү керек.]',
};

const RU: Texts = {
  stages: [
    '1. Организационный момент.\nМотивация',
    '2. Актуализация пройденного',
    '3. Сообщение темы и ожидаемых результатов',
    '4. Изучение нового материала',
    '5. Практическая работа',
    '6. Закрепление',
    '7. Подведение итогов урока; оценивание результатов',
  ],
  minutes: (n) => `${n} мин`,
  kc: 'КК',
  pkPlaceholder: 'ПК __',
  pkChoose: (n) => `ПК ${n} — выберите из программы`,
  types: {
    new: 'Урок изучения нового материала и первичного закрепления',
    practice: 'Урок закрепления знаний и формирования умений',
    test: 'Урок контроля знаний',
    analysis: 'Урок анализа контрольной работы, работа над ошибками',
    sor: 'Суммативное оценивание за раздел (СОР)',
    soch: 'Суммативное оценивание за четверть (СОЧ)',
  },
  teacherBlank: '______________________',
  dateBlank: '_________________',
  instruction: 'русский',
  target: (_cls, g) => (g !== null ? `(для учащихся ${g + 5}–${g + 6} лет, ${g} класс, язык обучения – русский)` : '(язык обучения – русский)'),
  methods: (type, subject, linked) => {
    const base =
      type === 'test'
        ? ['самостоятельная письменная работа', 'работа с критериями оценивания']
        : type === 'analysis'
          ? ['работа над ошибками', 'работа в парах', 'беседа']
          : type === 'practice'
            ? ['разноуровневые задания', 'работа в парах и группах', subject === 'math' ? 'решение примеров' : 'решение задач']
            : ['объяснение', 'беседа', 'работа в группах', ...(subject === 'math' ? ['решение примеров'] : [])];
    if (linked && type !== 'test') base.push('демонстрация 3D-модели Bilig');
    return base.join(', ');
  },
  materials: (lt) => ['учебник', 'компьютер', 'проектор или интерактивная панель', ...(lt ? [`Bilig: «${lt}»`] : [])].join(', '),
  task: (title) => `Формирование знаний, умений и компетентностей по теме «${title}»`,
  goalEdu: (title) => `Учащиеся изучат основные понятия и способы действий по теме «${title}».`,
  outcomeEdu: (title) => `Учащиеся объясняют и применяют знания по теме «${title}»;`,
  outcomeFrom: (o) => `Учащиеся смогут:\n${o.map((x) => `– ${x}`).join('\n')}`,
  taskTest: (sc) => `Проверить знания и умения учащихся по теме «${sc}».`,
  outcomeTest: 'Учащиеся самостоятельно выполняют задания и показывают свои знания;',
  taskAnalysis: (sc) => `Проанализировать результаты контрольной работы по теме «${sc}», исправить ошибки.`,
  outcomeAnalysis: 'Учащиеся находят свои ошибки и объясняют верное решение;',
  goalDev: (s) =>
    s === 'math'
      ? 'Развивать логическое мышление, вычислительные навыки и умение доказывать.'
      : s && NATURAL.has(s)
        ? 'Развивать умения наблюдать, проводить опыт и делать выводы.'
        : 'Развивать мышление, умение анализировать и высказывать своё мнение.',
  outcomeDev: 'Учащиеся самостоятельно выполняют задания и обосновывают ответ;',
  goalUp: 'Воспитывать умение работать в группе, слушать и уважать мнение других.',
  outcomeUp: 'Учащиеся работают в группе согласованно и честно оценивают работу друг друга.',
  organise: 'Приветствие, проверка готовности к уроку.',
  motivate: 'Мотивация: короткий вопрос или пример из жизни по теме.',
  motivateFrom: (title, text) => `Мотивация: «${title}» — ${text} Вопрос классу: как это связано с темой урока?`,
  studentsReady: 'Готовятся к уроку, высказывают мнение.',
  recall: (p) => (p ? `Короткий опрос по теме «${p}».` : 'Короткий опрос по основным понятиям прошлой темы.'),
  studentsRecall: 'Отвечают на вопросы, вспоминают изученное.',
  announce: ['Показываются тема и цели урока.', 'Кратко объясняются ожидаемые результаты и ход урока.'],
  studentsAnnounce: 'Читают цели, называют свои ожидания.',
  explain: (title) => [`Объяснение основных понятий, определений и примеров по теме «${title}».`, 'Работа с материалом учебника.'],
  hint: (s) => `Совет: ${s}`,
  studentsNew: 'Воспринимают новый материал, записывают основные понятия в тетрадь.',
  studentsModel: (c) => `Рассматривают на 3D-модели Bilig: ${c}; записывают основные понятия.`,
  practice: 'Группам даётся практическое задание, учитель контролирует выполнение.',
  practiceProcess: (title, io) => `Практическая работа: «${title}»${io ? ` (${io})` : ''}. Группы выполняют шаги и записывают результат.`,
  practiceCompare: (cols, rows) => `Таблица сравнения: ${cols}${rows ? ` (${rows})` : ''}. Группы заполняют таблицу.`,
  studentsPractice: 'Выполняют задание в группе, обсуждают результат.',
  consolidate: 'Задания на закрепление, контроль работы групп.',
  consolidateExample: (title, text) => `Пример из жизни: «${title}» — ${text}`,
  studentsConsolidate: 'Выполняют задания, проверяют ответы.',
  miniTest: 'Короткий мини-тест.',
  miniTestFrom: (s) => `Мини-тест:\n${s.map((x, i) => `${'абв'[i]}) ${x}`).join('\n')}`,
  wrapUp: 'Подведение итогов урока, оценивание работы учащихся.',
  homeworkLine: (hw) => `Домашнее задание: ${hw}`,
  studentsWrap: 'Отвечают на мини-тест, оценивают свою работу, записывают домашнее задание.',
  practiceRules: (title) => `Краткое повторение основных правил и формул по теме «${title}».`,
  practiceProblems: (title) => `Решение примеров и задач по теме «${title}» (разноуровневые задания).`,
  studentsProblems: 'Решают примеры самостоятельно и в парах, проверяют ответы.',
  testRules: 'Объяснение условий контрольной работы и критериев оценивания.',
  studentsTestRules: 'Слушают условия, задают вопросы.',
  testRun: (b) => `Раздаются варианты контрольной работы, учитель следит за временем.${b ? ` Дополнительно: тест Bilig «${b}».` : ''}`,
  studentsTest: 'Самостоятельно выполняют контрольную работу.',
  testCollect: 'Сбор работ.',
  studentsHandIn: 'Сдают работы.',
  testWrap: 'Подведение итогов; анализ работы — на следующем уроке.',
  studentsTestWrap: 'Говорят, какие задания были трудными.',
  analysisReview: 'Разбор результатов контрольной работы и типичных ошибок.',
  studentsAnalysis: 'Находят свои ошибки, понимают их причину.',
  analysisFix: 'Решение похожих заданий на типичные ошибки.',
  studentsFix: 'Исправляют ошибки, решают похожие задания.',
  formative: 'Формативное оценивание.',
  summative: 'Суммативное оценивание.',
  textbookPlace: (b, n, p) => `${b}${n ? `, § ${n}` : ''}${pagesRu(p)}`,
  subjectBook: (s, g) => `Учебник «${cap(s)}»${g !== null ? ` для ${g} класса` : ''}`,
  biligTopic: (title) => `Платформа Bilig: «${title}» (3D-модель, тур, тест)`,
  bilig: 'Платформа Bilig',
  homeworkRead: (n, p) => `§ ${n} прочитать${pagesRu(p)}`,
  homeworkDefault: 'Повторить пройденную тему, закончить задания в тетради.',
  homeworkTest: 'Домашнее задание не задаётся.',
  draftNote: '[Черновик создан Bilig автоматически — учитель проверяет его, выбирает коды ПК и вносит правки.]',
};

const EN: Texts = {
  stages: [
    '1. Organisation.\nMotivation',
    '2. Review of the previous lesson',
    '3. Topic and expected learning outcomes',
    '4. New information on the topic',
    '5. Practical work',
    '6. Consolidation',
    '7. Summary of the lesson; assessment',
  ],
  minutes: (n) => `${n} min`,
  kc: 'KC',
  pkPlaceholder: 'SC __',
  pkChoose: (n) => `SC ${n} — choose from the curriculum`,
  types: {
    new: 'Learning new material and first practice',
    practice: 'Consolidation and skills practice',
    test: 'Assessment of knowledge',
    analysis: 'Review of the test, working on mistakes',
    sor: 'Summative assessment of the unit',
    soch: 'Summative assessment of the term',
  },
  teacherBlank: '______________________',
  dateBlank: '_________________',
  instruction: 'English',
  target: (_cls, g) => (g !== null ? `(students aged ${g + 5}–${g + 6}, grade ${g}, language of instruction: English)` : '(language of instruction: English)'),
  methods: (type, subject, linked) => {
    const base =
      type === 'test'
        ? ['individual written test', 'working with assessment criteria']
        : type === 'analysis'
          ? ['working on mistakes', 'pair work', 'discussion']
          : type === 'practice'
            ? ['tasks by level', 'pair and group work', subject === 'math' ? 'worked examples' : 'problem solving']
            : ['explanation', 'questions and answers', 'group work', ...(subject === 'math' ? ['worked examples'] : [])];
    if (linked && type !== 'test') base.push('Bilig 3D model demonstration');
    return base.join(', ');
  },
  materials: (lt) => ['textbook', 'computer', 'projector or interactive panel', ...(lt ? [`Bilig: “${lt}”`] : [])].join(', '),
  task: (title) => `Build knowledge, skills and competences on “${title}”`,
  goalEdu: (title) => `Students learn the key concepts and methods of “${title}”.`,
  outcomeEdu: (title) => `Students can explain and apply what they learned about “${title}”;`,
  outcomeFrom: (o) => `Students will be able to:\n${o.map((x) => `– ${x}`).join('\n')}`,
  taskTest: (sc) => `Check students’ knowledge and skills on “${sc}”.`,
  outcomeTest: 'Students complete the tasks on their own and show what they know;',
  taskAnalysis: (sc) => `Review the test on “${sc}” and correct the mistakes.`,
  outcomeAnalysis: 'Students find their mistakes and explain the correct solution;',
  goalDev: (s) =>
    s === 'math'
      ? 'Develop logical thinking, calculation and reasoning skills.'
      : s && NATURAL.has(s)
        ? 'Develop observation, experimenting and drawing conclusions.'
        : 'Develop thinking, analysis and expressing an opinion.',
  outcomeDev: 'Students complete tasks on their own and justify their answers;',
  goalUp: 'Foster group work, listening to and respecting others.',
  outcomeUp: 'Students work together and assess each other fairly.',
  organise: 'Greeting, checking that the class is ready.',
  motivate: 'Motivation: a short question or a real-life example on the topic.',
  motivateFrom: (title, text) => `Motivation: “${title}” — ${text} Ask the class: how is this connected to today’s topic?`,
  studentsReady: 'Get ready for the lesson and share their ideas.',
  recall: (p) => (p ? `Quick questions on the previous topic “${p}”.` : 'Quick questions on the key ideas of the previous topic.'),
  studentsRecall: 'Answer the questions and recall what they know.',
  announce: ['The topic and goals of the lesson are shown.', 'Expected outcomes and the lesson plan are briefly explained.'],
  studentsAnnounce: 'Read the goals and say what they expect.',
  explain: (title) => [`Key concepts, definitions and examples of “${title}” are explained.`, 'Work with the textbook.'],
  hint: (s) => `Tip: ${s}`,
  studentsNew: 'Take in the new material and note the key concepts.',
  studentsModel: (c) => `Explore the Bilig 3D model: ${c}; note the key concepts.`,
  practice: 'Groups get a practical task; the teacher monitors the work.',
  practiceProcess: (title, io) => `Practical work: “${title}”${io ? ` (${io})` : ''}. Groups follow the steps and record the result.`,
  practiceCompare: (cols, rows) => `Comparison table: ${cols}${rows ? ` (${rows})` : ''}. Groups fill in the table.`,
  studentsPractice: 'Do the task in groups and discuss the result.',
  consolidate: 'Consolidation tasks; the teacher monitors the groups.',
  consolidateExample: (title, text) => `Real-life example: “${title}” — ${text}`,
  studentsConsolidate: 'Do the tasks and check their answers.',
  miniTest: 'A short mini-test.',
  miniTestFrom: (s) => `Mini-test:\n${s.map((x, i) => `${'abc'[i]}) ${x}`).join('\n')}`,
  wrapUp: 'Summary of the lesson; students’ work is assessed.',
  homeworkLine: (hw) => `Homework: ${hw}`,
  studentsWrap: 'Answer the mini-test, assess their work, write down the homework.',
  practiceRules: (title) => `Brief reminder of the key rules and formulas of “${title}”.`,
  practiceProblems: (title) => `Examples and problems on “${title}” (tasks by level).`,
  studentsProblems: 'Solve examples on their own and in pairs, check the answers.',
  testRules: 'The test conditions and assessment criteria are explained.',
  studentsTestRules: 'Listen to the conditions and ask questions.',
  testRun: (b) => `Test papers (by variant) are handed out; the teacher keeps time.${b ? ` Extra: Bilig test “${b}”.` : ''}`,
  studentsTest: 'Do the test on their own.',
  testCollect: 'Papers are collected.',
  studentsHandIn: 'Hand in their papers.',
  testWrap: 'Summary; the test is reviewed next lesson.',
  studentsTestWrap: 'Say which tasks were difficult.',
  analysisReview: 'Results of the test and the most common mistakes are reviewed.',
  studentsAnalysis: 'Find their mistakes and understand why.',
  analysisFix: 'Similar tasks on the common mistakes are solved.',
  studentsFix: 'Correct their mistakes and solve similar tasks.',
  formative: 'Formative assessment.',
  summative: 'Summative assessment.',
  textbookPlace: (b, n, p) => `${b}${n ? `, § ${n}` : ''}${pagesEn(p)}`,
  subjectBook: (s, g) => `${cap(s)} textbook${g !== null ? `, grade ${g}` : ''}`,
  biligTopic: (title) => `Bilig platform: “${title}” (3D model, tour, quiz)`,
  bilig: 'Bilig platform',
  homeworkRead: (n, p) => `Read § ${n}${pagesEn(p)}`,
  homeworkDefault: 'Review the topic and finish the tasks in the notebook.',
  homeworkTest: 'No homework.',
  draftNote: '[Draft generated automatically by Bilig — the teacher checks it, chooses the SC codes and edits it.]',
};

export const PLAN_TEXTS: Record<Lang, Texts> = { ky: KY, ru: RU, en: EN };

// ---------------------------------------------------------------------------
// topic package → plan pieces
// ---------------------------------------------------------------------------

interface TopicPieces {
  title: string;
  goal: string;
  objectives: string[];
  motivation: { title: string; text: string } | null;
  tourSteps: string[];
  hints: string[];
  concepts: string;
  practical: { kind: 'process'; title: string; io: string } | { kind: 'compare'; cols: string; rows: string } | null;
  stemExample: { title: string; text: string } | null;
  quizStems: string[];
  place: { book: string; number: string; pages?: { from: number; to: number } } | null;
}

function topicPieces(pkg: ContentPackage, textbooks: readonly Textbook[], lang: Lang, grade: number | null): TopicPieces {
  const tp = pkg.topic;
  const objectives = (pkg.objectives ?? []).filter((o) => tp.objectiveKeys.includes(o.key)).map((o) => t(o.text, lang)).filter(Boolean);
  const simple = tp.examples.simple[0];
  const steps = tp.activities.tour?.steps ?? [];
  const tourSteps = steps.slice(0, 3).map((s) => shorten(firstSentence(t(s.text, lang)), 160)).filter(Boolean);
  const hints = steps
    .slice(0, 4)
    .map((s) => (s.teacherNote ? shorten(firstSentence(t(s.teacherNote, lang)), 140) : ''))
    .filter(Boolean)
    .slice(0, 2);
  const concepts = topicConcepts(pkg)
    .slice(0, 3)
    .map((c) => t(c.title, lang).toLocaleLowerCase(lang === 'en' ? 'en' : 'ru'))
    .join(', ');
  let practical: TopicPieces['practical'] = null;
  const proc = pkg.processes.find((p) => tp.activities.processKeys.includes(p.key)) ?? pkg.processes[0];
  if (proc) {
    const io = [t(proc.inputs, lang), t(proc.outputs, lang)].filter(Boolean).join(' → ');
    practical = { kind: 'process', title: t(proc.title, lang), io: shorten(io, 120) };
  } else if (tp.activities.comparison) {
    const cmp = tp.activities.comparison;
    const conceptsByKey = new Map(pkg.concepts.map((c) => [c.key, c]));
    const samples = new Map((tp.samples ?? []).map((s) => [s.key, s]));
    const cols = cmp.columns
      .map((c) => (c.kind === 'sample' ? t(samples.get(c.key)?.title, lang) : t(conceptsByKey.get(c.key)?.title, lang)))
      .filter(Boolean)
      .join(', ');
    const labels = new Map((pkg.propertyTypes ?? []).map((p) => [p.key, t(p.label, lang)]));
    const rows = cmp.rows.map((r) => labels.get(r) ?? '').filter(Boolean).join(', ');
    if (cols) practical = { kind: 'compare', cols, rows };
  }
  const stem = tp.examples.stem[0];
  const itemsByKey = new Map(pkg.items.map((i) => [i.key, i]));
  const ordered = (tp.activities.quiz?.itemKeys ?? pkg.items.map((i) => i.key)).map((k) => itemsByKey.get(k)).filter((i) => !!i);
  const quizStems = ordered
    .filter((i) => i.type === 'single' || i.type === 'multiple')
    .slice(0, 3)
    .map((i) => shorten(t(i.prompt, lang), 140));
  const places = placesOfTopic(textbooks, tp.key);
  const books = new Map(textbooks.map((b) => [b.key, b]));
  const ranked = [...places].sort((a, b) => {
    const A = books.get(a.textbookKey)!;
    const B = books.get(b.textbookKey)!;
    const score = (x: Textbook) => (x.lang === lang ? 2 : 0) + (grade !== null && x.grade === grade ? 1 : 0);
    return score(B) - score(A);
  });
  const p = ranked[0];
  const book = p ? books.get(p.textbookKey) : undefined;
  return {
    title: t(tp.title, lang),
    goal: t(tp.goal, lang),
    objectives,
    motivation: simple ? { title: t(simple.title, lang), text: shorten(t(simple.text, lang), 200) } : null,
    tourSteps,
    hints,
    concepts,
    practical,
    stemExample: stem ? { title: t(stem.title, lang), text: shorten(firstSentence(t(stem.text, lang)), 160) } : null,
    quizStems,
    place: p && book ? { book: t(book.shortTitle ?? book.title, lang), number: p.number, ...(p.pages ? { pages: p.pages } : {}) } : null,
  };
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

export function buildPlanContent(input: PlanInput): PlanContent {
  const { row, cls, lang, plan } = input;
  const T = PLAN_TEXTS[lang];
  // v0.10.0: a СОР / СОЧ is planned like a test lesson; only its type label differs.
  const type = row.type === 'sor' || row.type === 'soch' ? 'test' : row.type;
  const grade = gradeOf(cls, plan.grade);
  const topicTitle = row.title.trim() || '—';
  const tp = input.topic ? topicPieces(input.topic.pkg, input.topic.textbooks, lang, grade) : null;
  const subjectKey = plan.subjectKey ?? input.topic?.pkg.subject.key ?? null;
  const subjectName = plan.subjectName.trim() || (input.topic ? t(input.topic.pkg.subject.title, lang) : '');

  // homework
  const homework = row.homework.trim()
    ? row.homework.trim()
    : type === 'test'
      ? T.homeworkTest
      : tp?.place
        ? T.homeworkRead(tp.place.number, tp.place.pages)
        : T.homeworkDefault;

  // stage texts: default (rule-based) draft
  const teacher: string[][] = [
    [T.organise, tp?.motivation ? T.motivateFrom(tp.motivation.title, tp.motivation.text) : T.motivate],
    [T.recall(input.prev?.title.trim() || null)],
    [...T.announce],
    T.explain(topicTitle),
    [T.practice],
    [T.consolidate],
    [tp?.quizStems.length ? T.miniTestFrom(tp.quizStems) : T.miniTest, T.wrapUp, T.homeworkLine(homework)],
  ];
  const student: string[] = [T.studentsReady, T.studentsRecall, T.studentsAnnounce, T.studentsNew, T.studentsPractice, T.studentsConsolidate, T.studentsWrap];
  const assessment: string[] = Array(STAGE_COUNT).fill(T.formative);

  if (tp) {
    if (tp.tourSteps.length >= 1) teacher[3] = [...tp.tourSteps, ...tp.hints.map(T.hint)];
    if (tp.concepts) student[3] = T.studentsModel(tp.concepts);
    if (tp.practical)
      teacher[4] = [tp.practical.kind === 'process' ? T.practiceProcess(tp.practical.title, tp.practical.io) : T.practiceCompare(tp.practical.cols, tp.practical.rows)];
    if (tp.stemExample) teacher[5] = [T.consolidateExample(tp.stemExample.title, tp.stemExample.text), T.consolidate];
  }

  if (type === 'practice') {
    teacher[3] = [T.practiceRules(topicTitle), ...(tp ? tp.tourSteps.slice(0, 2) : [])];
    teacher[5] = [T.practiceProblems(topicTitle), ...(tp?.stemExample ? [T.consolidateExample(tp.stemExample.title, tp.stemExample.text)] : [])];
    student[5] = T.studentsProblems;
  } else if (type === 'test') {
    teacher[3] = [T.testRules];
    student[3] = T.studentsTestRules;
    teacher[4] = [T.testRun(tp ? tp.title : null)];
    student[4] = T.studentsTest;
    teacher[5] = [T.testCollect];
    student[5] = T.studentsHandIn;
    teacher[6] = [T.testWrap];
    student[6] = T.studentsTestWrap;
    assessment[4] = T.summative;
    assessment[5] = T.summative;
  } else if (type === 'analysis') {
    teacher[3] = [T.analysisReview];
    student[3] = T.studentsAnalysis;
    teacher[5] = [T.analysisFix];
    student[5] = T.studentsFix;
  }
  if (type !== 'test' && tp?.quizStems.length) assessment[6] = `${T.formative}\n${T.summative}`;

  const times = STAGE_TIMES[type];
  const stages: PlanStage[] = T.stages.map((name, k) => ({
    name,
    minutes: T.minutes(times[k]),
    teacher: teacher[k].length > 1 ? numbered(teacher[k]) : teacher[k][0],
    student: student[k],
    kc: KC[k].map((n) => `${T.kc} ${n}`).join('\n'),
    pk: T.pkPlaceholder,
    assessment: assessment[k],
  }));
  const totalMinutes = times.reduce((a, b) => a + b, 0);
  if (totalMinutes !== 45) throw new Error('lesson plan must total 45 minutes');

  const sources: string[] = [];
  if (tp?.place) sources.push(T.textbookPlace(tp.place.book, tp.place.number, tp.place.pages));
  else if (subjectName) sources.push(T.subjectBook(subjectName, grade));
  sources.push(tp ? T.biligTopic(tp.title) : T.bilig);

  // what a test / analysis lesson checks: the linked topic, the КТП section, or the subject
  const scope = tp?.title || row.section?.title || cap(subjectName) || topicTitle;
  const checking = type === 'test' || type === 'analysis';
  const task = checking ? (type === 'test' ? T.taskTest(scope) : T.taskAnalysis(scope)) : tp?.goal || T.task(topicTitle);
  const goal1 = checking ? task : tp?.goal || T.goalEdu(topicTitle);
  const outcome1 = checking
    ? type === 'test'
      ? T.outcomeTest
      : T.outcomeAnalysis
    : tp?.objectives.length
      ? T.outcomeFrom(tp.objectives)
      : T.outcomeEdu(topicTitle);
  return {
    lang,
    classLabel: cls,
    date: fmtDate(row.dates[cls]) || T.dateBlank,
    teacher: plan.teacherName.trim() || T.teacherBlank,
    subject: cap(subjectName),
    lessonType: T.types[row.type],
    topic: topicTitle,
    methods: T.methods(type, subjectKey, !!tp),
    target: T.target(cls, grade),
    task,
    materials: T.materials(tp ? tp.title : null),
    goal1,
    outcome1,
    goal2: T.goalDev(subjectKey),
    outcome2: T.outcomeDev,
    goal3: T.goalUp,
    outcome3: T.outcomeUp,
    pk1: T.pkChoose(1),
    pk2: T.pkChoose(2),
    pk3: T.pkChoose(3),
    stages,
    sources,
    homework,
    draftNote: T.draftNote,
    totalMinutes,
  };
}
