/** Expert checks on generated items: language, size, options (contract 0.9.0 cost/quality pass). */
import { describe, expect, it } from 'vitest';
import { looksLikeLang, validateGenerated } from './generate.js';

describe('looksLikeLang', () => {
  it.each([
    // Kyrgyz, with and without ө/ү/ң
    ['ky', 'Ылдамдык — бул дененин убакыт бирдигинде өткөн жолу. Аны v = s/t формуласы менен эсептейбиз.', true],
    ['ky', 'Туурабы: «Бардык клеткалардын ядросу бар.» Бактериялардын ядросу жок, ошондуктан бул туура эмес.', true],
    ['ky', 'Магний кычкылтек менен реакцияга кирип, ак түстөгү магний оксидин пайда кылат.', true],
    // drift: Russian or Kazakh instead of Kyrgyz
    ['ky', 'Скорость — это путь, пройденный телом за единицу времени. Её вычисляют по формуле v = s/t.', false],
    ['ky', 'Жылдамдық — дененің уақыт бірлігінде жүрген жолы. Оны v = s/t формуласымен есептейміз.', false],
    // Russian
    ['ru', 'Скорость — это путь, пройденный телом за единицу времени.', true],
    ['ru', 'Ылдамдык — бул дененин убакыт бирдигинде өткөн жолу.', false],
    // English
    ['en', 'Speed is the distance an object travels per unit of time.', true],
    ['en', 'Скорость — это путь за единицу времени.', false],
    // short texts get the benefit of the doubt
    ['ky', 'Ядро', true],
  ] as const)('%s: %s → %s', (lang, text, ok) => expect(looksLikeLang(text, lang)).toBe(ok));
});

describe('validateGenerated: expert rules', () => {
  const keys = new Set(['phys.speed']);
  const q = (over: Record<string, unknown> = {}) => ({
    prompt: 'Велосипедчи 10 секундада 50 метр жол жүрдү. Анын ылдамдыгы канча?',
    options: [{ key: 'a', text: '5 м/с' }, { key: 'b', text: '50 м/с' }, { key: 'c', text: '0,2 м/с' }],
    answer: 'a',
    explanation: 'Ылдамдык жолдун убакытка катышы: 50 м / 10 с = 5 м/с.',
    ...over,
  });

  it('keeps a good Kyrgyz question and a true/false one', () => {
    const tf = q({ prompt: 'Туурабы: ылдамдык км/саат менен да өлчөнөт?', options: [{ key: 'a', text: 'Туура' }, { key: 'b', text: 'Туура эмес' }], explanation: 'Ооба, км/саат да ылдамдыктын бирдиги.' });
    expect(validateGenerated('quiz', { items: [q(), tf] }, keys, new Set(), 5, 'ky').quiz).toHaveLength(2);
  });

  it.each([
    ['Russian instead of Kyrgyz', q({ prompt: 'Велосипедист проехал 50 метров за 10 секунд. Какова его скорость в этом случае?', explanation: 'Скорость — это отношение пути ко времени: 50 м / 10 с.' })],
    ['an «all of the above» option', q({ options: [{ key: 'a', text: '5 м/с' }, { key: 'b', text: '50 м/с' }, { key: 'c', text: 'Бардыгы туура' }] })],
    ['five options', q({ options: ['a', 'b', 'c', 'd', 'e'].map((k, i) => ({ key: k, text: `${i + 1} м/с` })) })],
    ['a too long question', q({ prompt: `${'Велосипедчи жол жүрдү. '.repeat(15)}Ылдамдыгы канча?` })],
  ])('drops %s', (_name, item) => {
    const v = validateGenerated('quiz', { items: [item] }, keys, new Set(), 5, 'ky');
    expect(v.quiz).toHaveLength(0);
    expect(v.rejected).toBe(1);
  });

  it('a STEM example needs its field (s, t, e, m) and the right size', () => {
    const ok = { title: 'Жол радары', text: 'Полиция радары кыймылдагы машинанын ылдамдыгын толкундун жыштыгынын өзгөрүшү боюнча өлчөйт.', field: 't' };
    expect(validateGenerated('stem', { items: [ok] }, keys, new Set(), 5, 'ky').examples).toHaveLength(1);
    expect(validateGenerated('stem', { items: [{ ...ok, field: undefined }] }, keys, new Set(), 5, 'ky').examples).toHaveLength(0);
    expect(validateGenerated('stem', { items: [{ ...ok, title: 'Жол радары '.repeat(10) }] }, keys, new Set(), 5, 'ky').examples).toHaveLength(0);
  });
});
