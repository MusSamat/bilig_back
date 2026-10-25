/**
 * Link КТП lessons to Bilig topics (pure).
 *
 * Text per topic: its title in ky/ru/en, the titles of textbook lessons that
 * map to it (a strong signal: the КТП usually copies the textbook) and its
 * concept titles (a weaker one). Words are compared Kyrgyz/Russian-aware:
 * lower case, ё → е, no punctuation/numbering/«(10 саат)», and a word matches
 * another when they are equal, a ≥ 4-letter word is a prefix of the other
 * («атом» ~ «атомдун»), or they differ only from the shorter word's last
 * letter on (≥ 5 letters shared) — case endings and the к/г, п/б mutations at
 * the stem end, but not a different word on the same root.
 *
 * Score 0..1 = max over the topic's texts of max(Dice, containment), where
 * containment (every word of the topic text is in the lesson title) =
 * 0.5 + 0.5 · matched / lesson words. Candidates of the plan's subject and
 * grade are tried first (threshold 0.6), then the subject's other grades
 * (0.7), then other subjects (0.8) — concept-only hits (× 0.75) never cross
 * subjects.
 */
import { LANGS, topicConcepts, type ContentPackage, type Textbook } from '@bilig/content-model';
import type { KtpRow } from '@bilig/content-model/api';
import { TYPE_WORDS } from './lesson-type.js';

export const MATCH_THRESHOLD = 0.6;
const THRESHOLDS = [MATCH_THRESHOLD, 0.7, 0.8] as const;
const CONCEPT_WEIGHT = 0.75;

const STOP = new Set([
  // ky
  'жана', 'менен', 'боюнча', 'үчүн', 'деген', 'анын', 'алардын', 'бул', 'ал', 'же', 'да', 'дагы', 'жб', 'тема', 'темасы', 'темага',
  'сабак', 'сабагы', 'бөлүм', 'кириш', 'кайталоо', 'жалпы',
  // ru
  'и', 'в', 'во', 'на', 'с', 'со', 'по', 'для', 'его', 'их', 'о', 'об', 'от', 'до', 'из', 'к', 'у', 'за', 'при', 'как', 'что', 'это',
  'тема', 'теме', 'темы', 'урок', 'раздел', 'введение',
  // en
  'and', 'the', 'of', 'a', 'an', 'in', 'on', 'to', 'for', 'with', 'lesson', 'topic',
]);

export function tokens(text: string): string[] {
  const t = text
    .toLocaleLowerCase('ru')
    .normalize('NFC')
    .replace(/ё/g, 'е')
    .replace(/[(\[]\s*\d{1,3}\s*(?:саат\p{L}*|час\p{L}*|ч)\.?\s*[)\]]/gu, ' ')
    .replace(/§\s*[\d.]+/g, ' ')
    .replace(/№\s*\d+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ');
  return t.split(' ').filter((w) => w.length > 1 && !/^\d+$/.test(w) && !STOP.has(w) && !TYPE_WORDS.has(w));
}

/**
 * How well two words match, 0..1: 1 when equal or one is a ≥ 4-letter prefix of the other (an ending:
 * «атом» ~ «атомдун»); otherwise the shared prefix (≥ 5 letters) over the shorter word — a mutated stem
 * end scores slightly lower than an exact word («ылдамдык» ~ «ылдамдыгы» 7/8); a different word on the
 * same root does not match («ылдамдык» speed ≠ «ылдамдануу» acceleration).
 */
export function wordWeight(a: string, b: string): number {
  if (a === b) return 1;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length >= 4 && l.startsWith(s)) return 1;
  let i = 0;
  while (i < s.length && s[i] === l[i]) i++;
  // Only the stem's last letter may differ (к/г, п/б mutation before an ending): «ылдамдык» ~ «ылдамдыгы»,
  // «скорость» ~ «скорости»; a different word on the same root is not the same word («ылдамдануу»).
  return i >= 5 && i >= s.length - 1 ? i / s.length : 0;
}

export const wordMatch = (a: string, b: string): boolean => wordWeight(a, b) > 0;

/** Unique words (by `wordMatch`), in order. */
function uniq(ws: string[]): string[] {
  const out: string[] = [];
  for (const w of ws) if (!out.some((o) => wordMatch(o, w))) out.push(w);
  return out;
}

export function similarity(q: readonly string[], d: readonly string[]): number {
  if (!q.length || !d.length) return 0;
  const used = new Array(d.length).fill(false);
  let m = 0;
  let w = 0;
  for (const word of q) {
    // The best unused partner, not the first: «ылдамдык» prefers «ылдамдык» over «ылдамдануу».
    let j = -1;
    let best = 0;
    d.forEach((x, k) => {
      const ww = used[k] ? 0 : wordWeight(word, x);
      if (ww > best) [j, best] = [k, ww];
    });
    if (j >= 0) {
      used[j] = true;
      m++;
      w += best;
    }
  }
  const dice = (2 * w) / (q.length + d.length);
  // Containment, scaled by how exact the matched words are.
  const contain = m === d.length ? (0.5 + (0.5 * w) / q.length) * (w / m) : 0;
  return Math.max(dice, contain);
}

interface TopicDoc {
  key: string;
  subjectKey: string;
  grade: number | null;
  strong: string[][];
  weak: string[][];
}

export interface TopicIndex {
  topics: TopicDoc[];
  keys: Set<string>;
}

export function buildTopicIndex(packages: readonly ContentPackage[], textbooks: readonly Textbook[] = []): TopicIndex {
  const lessonTitles = new Map<string, string[]>();
  for (const tb of textbooks)
    for (const ch of tb.chapters)
      for (const l of ch.lessons) {
        if (l.kind === 'review') continue;
        for (const k of l.topicKeys) {
          const list = lessonTitles.get(k) ?? [];
          for (const lang of LANGS) if (l.title[lang]) list.push(l.title[lang]);
          lessonTitles.set(k, list);
        }
      }
  const topics = packages.map((pkg) => {
    const tp = pkg.topic;
    const strong = [...LANGS.map((l) => tp.title[l] ?? ''), ...(lessonTitles.get(tp.key) ?? [])].map((s) => uniq(tokens(s))).filter((x) => x.length);
    const weak = topicConcepts(pkg)
      .flatMap((c) => LANGS.map((l) => c.title[l] ?? ''))
      .map((s) => uniq(tokens(s)))
      .filter((x) => x.length);
    return { key: tp.key, subjectKey: pkg.subject.key, grade: pkg.course?.grade ?? null, strong, weak };
  });
  return { topics, keys: new Set(topics.map((t) => t.key)) };
}

export interface MatchContext {
  subjectKey: string | null;
  grade: number | null;
}

export interface MatchResult {
  topicKey: string;
  score: number;
}

/** The score, and the best match on the topic's own titles (the tie-break between equal scores). */
function scoreParts(q: readonly string[], t: TopicDoc): { score: number; strong: number } {
  let strong = 0;
  for (const d of t.strong) strong = Math.max(strong, similarity(q, d));
  let weak = 0;
  for (const d of t.weak) weak = Math.max(weak, CONCEPT_WEIGHT * similarity(q, d));
  return { score: Math.max(strong, weak), strong };
}

export function matchTitle(index: TopicIndex, title: string, ctx: MatchContext): MatchResult | null {
  const q = uniq(tokens(title));
  if (!q.length) return null;
  const best: ((MatchResult & { strong: number }) | null)[] = [null, null, null];
  for (const t of index.topics) {
    const sameSubject = ctx.subjectKey === null || t.subjectKey === ctx.subjectKey;
    const sameGrade = ctx.grade === null || t.grade === null || t.grade === ctx.grade;
    const tier = !sameSubject ? 2 : sameGrade ? 0 : 1;
    const { score, strong } = scoreParts(q, t);
    if (score < THRESHOLDS[tier]) continue;
    // Equal scores (often two topics sharing a concept): the one whose own title / textbook lesson is closer.
    const cur = best[tier];
    if (!cur || score > cur.score + 1e-9 || (Math.abs(score - cur.score) <= 1e-9 && strong > cur.strong)) best[tier] = { topicKey: t.key, score, strong };
  }
  const hit = best.find(Boolean) ?? null;
  return hit ? { topicKey: hit.topicKey, score: Math.round(Math.min(1, hit.score) * 100) / 100 } : null;
}

type MatchableRow = Pick<KtpRow, 'index' | 'title' | 'type' | 'topicKey' | 'match'>;

/**
 * Set `topicKey` / `match` on rows. A teacher's link (`match.auto === false`)
 * is never touched; `only` limits the rows (re-match after a title edit).
 * Test and analysis lessons get a topic only when their title names one
 * («Контрольная работа по теме «Скорость»»): type words are not matched.
 */
export function applyMatches<R extends MatchableRow>(rows: R[], index: TopicIndex, ctx: MatchContext, only?: ReadonlySet<number>): R[] {
  return rows.map((r) => {
    if (only && !only.has(r.index)) return r;
    if (r.match && r.match.auto === false) return r;
    const hit = matchTitle(index, r.title, ctx);
    if (!hit) {
      const { match: _m, ...rest } = r;
      return { ...rest, topicKey: null } as R;
    }
    return { ...r, topicKey: hit.topicKey, match: { auto: true, score: hit.score } };
  });
}

