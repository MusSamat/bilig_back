/**
 * Lesson type from a КТП lesson title (ky + ru, a little en). The type sets
 * the stage timings of the generated plan. Order matters: analysis → СОР / СОЧ
 * (v0.10.0) → test → practice → new. (`\b` is ASCII-only in JS, so word starts are `(?<!\p{L})`.)
 */
import type { KtpLessonType } from '@bilig/content-model/api';

/** Lower-case, ё → е, punctuation → space. */
export const typeText = (s: string) =>
  s
    .toLocaleLowerCase('ru')
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const W = '(?<!\\p{L})'; // start of a word
const rx = (s: string) => new RegExp(s, 'u');

const TEST_WORD = '(текшерүү|текшерүүчү|контролдук|көзөмөл|контрольн|проверочн|самостоятельн|диагностическ|итогов|сор(?!\\p{L})|соч(?!\\p{L}))';

const ANALYSIS = [
  rx(`${W}${TEST_WORD}.*${W}(анализ|талда)`),
  rx(`${W}(анализ|талда)\\S*\\s+(\\S+\\s+)?${TEST_WORD}`),
  rx(`${W}анализ\\S*\\s+(диктант|теста|тестир)`),
  rx(`работа над ошибками|${W}каталар менен иште|${W}каталарды талда|${W}каталар устунде|${W}каталар үстүндө`),
];

/** v0.10.0: summative assessment of a chapter (СОР) and of a quarter (СОЧ), before the generic test rule. */
const SOR = [
  rx(`${W}сор(?!\\p{L})`),
  rx(`${W}суммативн\\S* оценивани\\S* (за|по) (раздел|главе|теме)`),
  rx(`${W}бөлүм боюнча суммативд`),
];
const SOCH = [
  rx(`${W}соч(?!\\p{L})`),
  rx(`${W}суммативн\\S* оценивани\\S* за (четверть|полугодие)`),
  rx(`${W}чейрек боюнча суммативд`),
];

const TESTS = [
  rx(`${W}(текшерүү|текшерүүчү|контролдук|көзөмөл|жыйынтыктоочу) иш|${W}өз алдынча иш`),
  rx(`${W}(контрольн|самостоятельн|проверочн|итогов|диагностическ)\\S* работ`),
  rx(`${W}(зачет|тест|тестирование|диктант|сынак|test)(?!\\p{L})`),
];

const PRACTICE = [
  rx(`${W}(мисал|маселе|көнүгүү|бышыктоо|кайталоо|жалпылоо)|${W}(практикалык|лабораториялык) иш`),
  rx(`${W}решение (задач|примеров|уравнений|упражнений)|${W}задач|${W}(практическ|лабораторн)\\S* работ|${W}(упражнени|закреплени|повторени|обобщени|практикум)`),
  rx(`${W}(practice|problem solving|exercises?|revision|review|lab work)(?!\\p{L})`),
];

export function lessonType(title: string): KtpLessonType {
  const t = typeText(title);
  if (!t) return 'new';
  if (ANALYSIS.some((r) => r.test(t))) return 'analysis';
  if (SOCH.some((r) => r.test(t))) return 'soch';
  if (SOR.some((r) => r.test(t))) return 'sor';
  if (TESTS.some((r) => r.test(t))) return 'test';
  if (PRACTICE.some((r) => r.test(t))) return 'practice';
  return 'new';
}

/** Words that only name the lesson type (stripped before topic matching). */
export const TYPE_WORDS = new Set([
  'текшерүү', 'текшерүүчү', 'контролдук', 'көзөмөл', 'иш', 'иши', 'ишти', 'иштөө', 'ишөө', 'анализ', 'анализдөө', 'талдоо',
  'өз', 'алдынча', 'жыйынтыктоочу', 'мисал', 'мисалдар', 'маселе', 'маселелер', 'көнүгүү', 'кайталоо', 'бышыктоо', 'жалпылоо',
  'практикалык', 'лабораториялык', 'каталар', 'каталарды', 'чыгаруу', 'тест', 'сынак', 'диктант',
  'контрольная', 'контрольной', 'контрольные', 'работа', 'работы', 'работе', 'самостоятельная', 'самостоятельной', 'проверочная',
  'проверочной', 'итоговая', 'итоговой', 'анализа', 'решение', 'задач', 'задачи', 'примеров', 'практическая', 'практической',
  'лабораторная', 'лабораторной', 'упражнения', 'закрепление', 'повторение', 'обобщение', 'зачет', 'ошибками', 'над',
  'test', 'practice', 'review', 'revision', 'lab', 'work',
  'сор', 'соч', 'суммативдик', 'баалоо', 'суммативное', 'оценивание', 'чейрек', 'четверть',
]);
