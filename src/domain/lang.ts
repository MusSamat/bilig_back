/** Accept-Language handling and fallback-chain localisation (TZ §9, §10: ky → ru → en). */
import { FALLBACK_CHAIN, LANGS, isLang, type Lang, type Localized } from '@bilig/content-model';

/** Pick the best supported language from an Accept-Language header (q-values honoured). */
export function negotiateLang(header: string | undefined, fallback: Lang = 'ky'): Lang {
  if (!header) return fallback;
  const prefs = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return { tag: tag.trim().toLowerCase().split('-')[0], q: q ? Number(q.slice(2)) || 0 : 1 };
    })
    .filter((p) => p.tag && p.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const p of prefs) if (isLang(p.tag)) return p.tag;
  return fallback;
}

/** Fallback chain for a requested language: requested first, then ky → ru → en. */
export const chainFor = (lang: Lang): Lang[] => [lang, ...FALLBACK_CHAIN.filter((l) => l !== lang)];

/** Fill empty locales of a Localized value from the chain, so `value[lang]` is never empty. */
export function fillLocalized(v: Localized, lang: Lang): Localized {
  const first = chainFor(lang).map((l) => v[l]).find((s) => !!s) ?? '';
  const out = { ...v };
  for (const l of LANGS) {
    if (!out[l]) out[l] = l === lang ? first : chainFor(l).map((x) => v[x]).find((s) => !!s) ?? '';
  }
  return out;
}

const isLocalized = (v: unknown): v is Localized =>
  !!v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).length === 3 && LANGS.every((l) => typeof (v as Record<string, unknown>)[l] === 'string');

/** Deep-apply `fillLocalized` to every Localized value inside a JSON document. */
export function localizeDeep<T>(doc: T, lang: Lang): T {
  if (Array.isArray(doc)) return doc.map((x) => localizeDeep(x, lang)) as T;
  if (isLocalized(doc)) return fillLocalized(doc, lang) as T;
  if (doc && typeof doc === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(doc)) out[k] = localizeDeep(v, lang);
    return out as T;
  }
  return doc;
}

/** Guess the language of free text (tutor «answer in the language of the question»). */
export function detectLang(text: string, fallback: Lang): Lang {
  if (/[ңөүҢӨҮ]/.test(text)) return 'ky';
  const cyr = (text.match(/[Ѐ-ӿ]/g) ?? []).length;
  const lat = (text.match(/[A-Za-z]/g) ?? []).length;
  if (cyr === 0 && lat === 0) return fallback;
  if (cyr > lat) return fallback === 'ky' ? 'ky' : 'ru';
  return 'en';
}
