/**
 * Topic-grounded assistant helpers (v0.4.0), pure and shared by the server,
 * the client and the mock API:
 *
 *  - `suggestQuestions`: follow-up questions about the current topic / concept
 *    (chips under the chat, and the server's answer to an off-topic question);
 *  - `glossaryMatches`: offline translation of a selection via the glossary;
 *  - `groundedAnswer` / `groundedGenerate`: deterministic answers, examples and
 *    practice questions built ONLY from the package. They back the server's
 *    `dev` tutor provider (everything works end to end without an LLM key) and
 *    the client's mock API. They never invent facts: every sentence comes from
 *    authored content, so they are a safe stand-in, not a model.
 */
import { topicConcepts, type ContentPackage } from './package.js';
import type { Example, ResolvedConcept, StemField } from './concept.js';
import { t, type Lang } from './i18n.js';

type Tpl = Record<Lang, string>;
const fill = (tpl: Tpl, lang: Lang, vars: Record<string, string>): string =>
  tpl[lang].replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');

const Q: Record<'what' | 'job' | 'where' | 'diff' | 'topicWhat' | 'topicParts' | 'myth' | 'life' | 'process', Tpl> = {
  what: { ky: '{name} деген эмне?', ru: 'Что такое {name}?', en: 'What is {name}?' },
  job: { ky: '{name} эмне үчүн керек?', ru: 'Зачем нужен элемент «{name}»?', en: 'Why is {name} important?' },
  where: { ky: '{name} кайда жайгашкан?', ru: 'Где находится {name}?', en: 'Where is {name} found?' },
  diff: { ky: '{a} менен {b} эмнеси менен айырмаланат?', ru: 'Чем {a} отличается от {b}?', en: 'How is {a} different from {b}?' },
  topicWhat: { ky: '{name} деген эмне?', ru: 'Что такое {name}?', en: 'What is {name}?' },
  topicParts: { ky: '{name} эмнелерден турат?', ru: 'Из чего состоит {name}?', en: 'What is {name} made of?' },
  myth: { ky: 'Чын эле «{text}»?', ru: 'Правда ли, что «{text}»?', en: 'Is it true that “{text}”?' },
  life: { ky: '«{name}» мисалын түшүндүрүп берчи', ru: 'Объясни пример «{name}»', en: 'Explain the example “{name}”' },
  process: { ky: '«{name}» кантип жүрөт?', ru: 'Как проходит процесс «{name}»?', en: 'How does “{name}” work?' },
};

const lower = (s: string, lang: Lang) => s.toLocaleLowerCase(lang === 'en' ? 'en' : lang === 'ru' ? 'ru' : 'ky');
const firstSentence = (s: string): string => {
  const m = /^(.+?[.!?])(\s|$)/.exec(s.trim());
  return (m ? m[1] : s).trim();
};
const norm = (s: string): string => s.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * v0.9.0: concept kinds that are physical things with a place in the model
 * (an organ, a bone, a layer, a device…). «Where is it?» and «what is it made
 * of?» only make sense for these — never for a speed, a force, a process or a
 * substance class.
 */
export const PHYSICAL_KINDS: ReadonlySet<string> = new Set([
  'structure', 'organelle', 'organ', 'tissue', 'bone', 'joint', 'muscle', 'chamber', 'vessel', 'airway', 'part', 'body',
  'layer', 'shell', 'sphere', 'boundary', 'zone', 'segment', 'planet', 'satellite', 'star', 'water-body', 'landform',
  'device', 'instrument', 'tool', 'solid', 'figure',
]);
const isPhysical = (c: Pick<ResolvedConcept, 'kind'>): boolean => PHYSICAL_KINDS.has(c.kind);
/** A misconception short enough to quote in a chip. */
const quotable = (s: string): string | null => {
  const one = firstSentence(s).replace(/[.!?]$/, '');
  return one.length >= 8 && one.length <= 90 ? one : null;
};

/**
 * Follow-up questions about the focus concept (or the topic), in `lang`. Never empty for a non-empty package.
 * Without a focus, the topic's own `starters` (written per topic by the authors) come first; the rest is
 * built from the topic's content — a common mistake to check, a real-life example, a process, a key concept —
 * and «where / what is it made of» is asked only about physical things (PHYSICAL_KINDS).
 */
export function suggestQuestions(
  pkg: ContentPackage,
  lang: Lang,
  opts: { conceptKey?: string | null; processKey?: string | null; count?: number } = {},
): string[] {
  const count = opts.count ?? 3;
  const all = topicConcepts(pkg);
  const concepts = all.filter((c) => !c.isContainer);
  const focus = opts.conceptKey ? all.find((c) => c.key === opts.conceptKey) : undefined;
  const out: string[] = [];
  const process = opts.processKey ? pkg.processes.find((p) => p.key === opts.processKey) : undefined;
  if (process) out.push(fill(Q.process, lang, { name: t(process.title, lang) }));
  if (focus) {
    const name = lower(t(focus.title, lang), lang);
    out.push(fill(Q.what, lang, { name }));
    if (isPhysical(focus)) out.push(fill(Q.job, lang, { name: t(focus.title, lang) }));
    const myth = focus.misconceptions.map((m) => quotable(t(m.text, lang))).find(Boolean);
    if (myth) out.push(fill(Q.myth, lang, { text: myth }));
    const other = focus.related.map((k) => pkg.concepts.find((c) => c.key === k)).find((c) => !!c) ?? concepts.find((c) => c.key !== focus.key);
    if (other) out.push(fill(Q.diff, lang, { a: t(focus.title, lang), b: lower(t(other.title, lang), lang) }));
    if (isPhysical(focus)) out.push(fill(Q.where, lang, { name }));
  } else {
    for (const s of pkg.topic.starters ?? []) out.push(t(s, lang));
    const name = lower(t(pkg.topic.title, lang), lang);
    out.push(fill(Q.topicWhat, lang, { name }));
    const myth = concepts.flatMap((c) => c.misconceptions).map((m) => quotable(t(m.text, lang))).find(Boolean);
    if (myth) out.push(fill(Q.myth, lang, { text: myth }));
    const life = pkg.topic.examples.simple[0] ?? pkg.topic.examples.stem[0];
    if (life) out.push(fill(Q.life, lang, { name: t(life.title, lang) }));
    const firstProcess = pkg.topic.activities.processKeys.map((k) => pkg.processes.find((p) => p.key === k)).find(Boolean);
    if (firstProcess) out.push(fill(Q.process, lang, { name: t(firstProcess.title, lang) }));
    const physicalShare = concepts.length ? concepts.filter(isPhysical).length / concepts.length : 0;
    if (physicalShare >= 0.5) out.push(fill(Q.topicParts, lang, { name }));
    for (const c of concepts.slice(0, 2)) out.push(fill(Q.what, lang, { name: lower(t(c.title, lang), lang) }));
  }
  return [...new Set(out.map((q) => q.trim()).filter(Boolean))].slice(0, count);
}

export interface GlossaryMatch {
  id: string;
  ky: string;
  ru: string;
  en: string;
}

/** Glossary terms that occur in `text` (any language), longest first. Offline «Перевести». */
export function glossaryMatches(pkg: ContentPackage, text: string, max = 5): GlossaryMatch[] {
  const hay = ` ${norm(text)} `;
  if (!hay.trim()) return [];
  return pkg.glossary
    .map((g) => {
      const hit = (['ky', 'ru', 'en'] as const).map((l) => norm(g[l])).filter((w) => w.length >= 3 && hay.includes(` ${w}`));
      return { g, len: Math.max(0, ...hit.map((w) => w.length)) };
    })
    .filter((x) => x.len > 0)
    .sort((a, b) => b.len - a.len)
    // The same term may be listed under several ids (per subject); show it once.
    .filter((x, i, all) => all.findIndex((y) => y.g.ky === x.g.ky && y.g.ru === x.g.ru && y.g.en === x.g.en) === i)
    .slice(0, max)
    .map(({ g }) => ({ id: g.id, ky: g.ky, ru: g.ru, en: g.en }));
}

// ---------------------------------------------------------------------------
// Grounded answers
// ---------------------------------------------------------------------------

export type AssistIntent = 'ask' | 'explain' | 'simpler' | 'example';

/** Score concepts by how well the text names them (all three languages, stem match). */
function matchConcepts(pkg: ContentPackage, text: string): ResolvedConcept[] {
  const q = ` ${norm(text)} `;
  return topicConcepts(pkg)
    .concat(pkg.concepts.filter((c) => !pkg.topic.conceptKeys.includes(c.key)) as ResolvedConcept[])
    .map((c) => {
      let score = 0;
      for (const l of ['ky', 'ru', 'en'] as const) {
        const w = norm(c.title[l]);
        if (!w) continue;
        const stem = w.length > 5 ? w.slice(0, w.length - 2) : w;
        if (q.includes(` ${stem}`)) score += w.length;
      }
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c);
}

const NO_MATCH: Tpl = {
  ky: 'Бул суроого теманын материалдарында жооп жок.',
  ru: 'В материалах темы нет ответа на этот вопрос.',
  en: 'The topic materials do not answer this question.',
};
const SIMPLY: Tpl = { ky: 'Жөнөкөй айтканда:', ru: 'Проще говоря:', en: 'Simply put:' };
const FOR_EXAMPLE: Tpl = { ky: 'Мисалы:', ru: 'Например:', en: 'For example:' };

export interface GroundedAnswer {
  /** Answer text with `[[concept.key]]` citation markers (the server's citation parser strips them). */
  text: string;
  /** Nothing in the material matched: the caller treats it as off-topic. */
  noAnswer: boolean;
}

/**
 * A short answer assembled from the package: the best-matching concept (by the
 * question, then the quote, then the focus) and, by intent, its description,
 * a plain analogy or a real-world example.
 */
export function groundedAnswer(
  pkg: ContentPackage,
  lang: Lang,
  input: { question: string; conceptKey?: string; quote?: string; intent?: AssistIntent },
): GroundedAnswer {
  const all = topicConcepts(pkg);
  const focus = input.conceptKey ? all.find((c) => c.key === input.conceptKey) : undefined;
  const best = matchConcepts(pkg, input.question)[0] ?? (input.quote ? matchConcepts(pkg, input.quote)[0] : undefined) ?? focus;
  const topicHit = norm(input.question).includes(norm(t(pkg.topic.title, lang)).slice(0, 5));
  if (!best && !topicHit && !input.quote) return { text: `${NO_MATCH[lang]} [[no-answer]]`, noAnswer: true };

  const intent = input.intent ?? 'ask';
  const lines: string[] = [];
  if (!best) {
    lines.push(t(pkg.topic.description, lang));
    const ex = intent === 'simpler' ? pkg.topic.examples.simple[0] : intent === 'example' ? pkg.topic.examples.stem[0] : undefined;
    if (ex) lines.push(`${intent === 'simpler' ? SIMPLY[lang] : FOR_EXAMPLE[lang]} ${t(ex.text, lang)}`);
    return { text: lines.join(' '), noAnswer: false };
  }
  const name = `${t(best.title, lang)} [[${best.key}]]`;
  if (intent === 'simpler') {
    const plain = best.analogy ? t(best.analogy, lang) : best.examples.simple[0] ? t(best.examples.simple[0].text, lang) : firstSentence(t(best.description, lang));
    lines.push(`${SIMPLY[lang]} ${name} — ${plain}`);
  } else if (intent === 'example') {
    const ex = best.examples.stem[0] ?? best.examples.simple[0];
    lines.push(`${name}. ${FOR_EXAMPLE[lang]} ${ex ? `${t(ex.title, lang)} — ${t(ex.text, lang)}` : t(best.description, lang)}`);
  } else {
    lines.push(`${name} — ${t(best.description, lang)}`);
    if (best.funFact) lines.push(t(best.funFact, lang));
  }
  return { text: lines.join(' '), noAnswer: false };
}

// ---------------------------------------------------------------------------
// Grounded generation («Ещё примеры» / «Ещё вопросы»)
// ---------------------------------------------------------------------------

export interface DraftExample {
  title: string;
  text: string;
  field?: StemField;
  conceptKey?: string;
  /** v0.9.1: school grades the item suits (shared by topics of these grades that teach the concept). */
  grades?: GradeRange;
}
/** v0.9.1: an inclusive range of school grades, 1–12. */
export interface GradeRange {
  from: number;
  to: number;
}
export interface DraftQuizItem {
  prompt: string;
  options: { key: string; text: string }[];
  answer: string;
  explanation: string;
  conceptKey?: string;
  grades?: GradeRange;
}

const G: Record<'analogy' | 'fact' | 'mistake' | 'which' | 'trueFalse' | 'true' | 'false' | 'related', Tpl> = {
  analogy: { ky: '{name}: салыштыруу', ru: '{name}: сравнение', en: '{name}: a comparison' },
  fact: { ky: '{name}: кызык факт', ru: '{name}: интересный факт', en: '{name}: a fun fact' },
  mistake: { ky: '{name}: көп кездешкен ката', ru: '{name}: частая ошибка', en: '{name}: a common mistake' },
  which: { ky: 'Бул эмне жөнүндө: «{text}»?', ru: 'О чём это: «{text}»?', en: 'What is this about: “{text}”?' },
  trueFalse: { ky: 'Туурабы: «{text}»?', ru: 'Верно ли: «{text}»?', en: 'True or false: “{text}”?' },
  true: { ky: 'Туура', ru: 'Верно', en: 'True' },
  false: { ky: 'Туура эмес', ru: 'Неверно', en: 'False' },
  related: { ky: '{a} кайсы түзүлүш менен байланышкан?', ru: 'С какой структурой связан элемент «{a}»?', en: 'Which structure is {a} linked to?' },
};

/** Stable pseudo-random order (FNV-1a over a seed): the same input gives the same draft. */
function seeded<T>(items: readonly T[], seed: string): T[] {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Concepts to draw from: the focus first, then its related ones, then the rest of the topic. */
function conceptOrder(pkg: ContentPackage, conceptKey?: string): ResolvedConcept[] {
  const all = topicConcepts(pkg).filter((c) => !c.isContainer);
  const focus = conceptKey ? topicConcepts(pkg).find((c) => c.key === conceptKey) : undefined;
  if (!focus) return all;
  const rel = focus.related.map((k) => all.find((c) => c.key === k)).filter((c): c is ResolvedConcept => !!c);
  return [focus, ...rel, ...all.filter((c) => c.key !== focus.key && !rel.includes(c))];
}

/** Signature used to avoid repeating an item (case/punctuation-insensitive). */
export const draftSignature = (s: string): string => norm(s).slice(0, 160);

/**
 * Up to `count` new examples or practice questions from authored material,
 * skipping anything whose signature is in `avoid` and anything already shown
 * on the concept card. Returns fewer when the material runs out.
 */
export function groundedGenerate(
  pkg: ContentPackage,
  lang: Lang,
  kind: 'simple' | 'stem' | 'quiz',
  opts: { conceptKey?: string; count: number; avoid?: Iterable<string> },
): { examples: DraftExample[]; quiz: DraftQuizItem[] } {
  const avoid = new Set(opts.avoid ?? []);
  const order = conceptOrder(pkg, opts.conceptKey);
  const focus = opts.conceptKey ? order[0] : undefined;
  // What the card already shows is never «more».
  const shown = focus ? focus.examples : pkg.topic.examples;
  for (const ex of [...shown.simple, ...shown.stem]) avoid.add(draftSignature(t(ex.text, lang)));

  if (kind === 'quiz') {
    const quiz: DraftQuizItem[] = [];
    const take = (q: DraftQuizItem) => {
      const sig = draftSignature(q.prompt);
      if (quiz.length >= opts.count || avoid.has(sig)) return;
      avoid.add(sig);
      quiz.push(q);
    };
    const pool = order.length ? order : topicConcepts(pkg);
    for (const c of pool) {
      const name = t(c.title, lang);
      // 1. «О чём это?» — the first sentence of a description, the structure's name hidden.
      const others = seeded(pool.filter((o) => o.key !== c.key), c.key).slice(0, 3);
      if (others.length >= 1) {
        const desc = firstSentence(t(c.description, lang)).replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '…');
        const opts4 = seeded([c, ...others], `${c.key}:o`).map((o, i) => ({ key: `o${i + 1}`, text: t(o.title, lang) }));
        take({
          prompt: fill(G.which, lang, { text: desc }),
          options: opts4,
          answer: opts4.find((o) => o.text === name)!.key,
          explanation: `${name} — ${t(c.description, lang)}`,
          conceptKey: c.key,
        });
      }
      // 2. Misconceptions as true/false.
      for (const m of c.misconceptions) {
        take({
          prompt: fill(G.trueFalse, lang, { text: t(m.text, lang) }),
          options: [
            { key: 'yes', text: G.true[lang] },
            { key: 'no', text: G.false[lang] },
          ],
          answer: 'no',
          explanation: t(m.correction, lang),
          conceptKey: c.key,
        });
      }
      // 3. Related structures.
      const rel = c.related.map((k) => pool.find((o) => o.key === k)).find((o): o is ResolvedConcept => !!o);
      const decoys = pool.filter((o) => o.key !== c.key && !c.related.includes(o.key));
      if (rel && decoys.length >= 2) {
        const opts3 = seeded([rel, ...seeded(decoys, `${c.key}:r`).slice(0, 2)], `${c.key}:ro`).map((o, i) => ({ key: `r${i + 1}`, text: t(o.title, lang) }));
        take({
          prompt: fill(G.related, lang, { a: name }),
          options: opts3,
          answer: opts3.find((o) => o.text === t(rel.title, lang))!.key,
          explanation: `${name} — ${firstSentence(t(c.description, lang))} ${t(rel.title, lang)} — ${firstSentence(t(rel.description, lang))}`,
          conceptKey: c.key,
        });
      }
      if (quiz.length >= opts.count) break;
    }
    return { examples: [], quiz };
  }

  const examples: DraftExample[] = [];
  const take = (e: DraftExample) => {
    const sig = draftSignature(e.text);
    if (examples.length >= opts.count || avoid.has(sig) || !e.text.trim()) return;
    avoid.add(sig);
    examples.push(e);
  };
  const fromList = (list: Example[], c?: ResolvedConcept) => {
    for (const ex of list) take({ title: t(ex.title, lang), text: t(ex.text, lang), ...(ex.field ? { field: ex.field } : {}), ...(c ? { conceptKey: c.key } : {}) });
  };
  if (kind === 'simple') {
    for (const c of order) {
      const name = t(c.title, lang);
      if (c.analogy) take({ title: fill(G.analogy, lang, { name }), text: t(c.analogy, lang), conceptKey: c.key });
      if (c.funFact) take({ title: fill(G.fact, lang, { name }), text: t(c.funFact, lang), conceptKey: c.key });
      for (const m of c.misconceptions) take({ title: fill(G.mistake, lang, { name }), text: `${t(m.text, lang)} → ${t(m.correction, lang)}`, conceptKey: c.key });
      fromList(c.examples.simple, c);
    }
    fromList(pkg.topic.examples.simple);
  } else {
    for (const c of order) fromList(c.examples.stem, c);
    fromList(pkg.topic.examples.stem);
  }
  return { examples, quiz: [] };
}
