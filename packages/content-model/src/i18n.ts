/**
 * Languages, localized strings and per-locale translation status (TZ §1, A-11).
 */
import { z } from 'zod';

/** Contract version shared by @bilig/content-model and @bilig/permissions. */
export const CONTRACT_VERSION = '0.8.0';

/**
 * The ACTIVE content languages: every Localized value carries exactly these
 * keys, and the publish checklist requires all of them.
 *
 * More languages (v0.3.0 design, nothing changes for existing data):
 *  - UI-only languages need no contract change: a client may ship UI strings
 *    for any `UiLangCode` (`UiLangCodeSchema`, `isUiLangCode`) and shows content in
 *    `contentLangFor(uiLang)` (exact match → base subtag → fallback).
 *  - A new CONTENT language is added in a minor version as an OPTIONAL key of
 *    `LocalizedSchema` (existing documents stay valid; `missingLangs` reports
 *    the gap, `t()` falls back along FALLBACK_CHAIN). Code must therefore not
 *    assume a Localized value has exactly three keys — use `isLocalizedValue`.
 *    Only after the content is translated does the checklist start requiring it.
 */
export const LANGS = ['ky', 'ru', 'en'] as const;
export const LangSchema = z.enum(LANGS);
export type Lang = z.infer<typeof LangSchema>;
/** Kyrgyz is the primary UI/content language. */
export const DEFAULT_LANG: Lang = 'ky';
/** Fallback chain used by `t()` after the requested language. */
export const FALLBACK_CHAIN: readonly Lang[] = ['ky', 'ru', 'en'];

export const isLang = (v: unknown): v is Lang =>
  typeof v === 'string' && (LANGS as readonly string[]).includes(v);

// v0.3.0 (additive): UI languages beyond the content set.

/** A UI language code (BCP 47 primary subtag + optional region): `ky`, `uz`, `kk`, `en-GB`. */
export const UI_LANG_RE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;
export const UiLangCodeSchema = z.string().regex(UI_LANG_RE, 'Invalid language code');
export type UiLangCode = Lang | (string & {});
export const isUiLangCode = (v: unknown): v is UiLangCode => typeof v === 'string' && UI_LANG_RE.test(v);

/**
 * Content language for a UI language: the language itself when content
 * exists in it, else its base subtag (`ru-KG` → `ru`), else `fallback`.
 */
export function contentLangFor(uiLang: string, fallback: Lang = DEFAULT_LANG): Lang {
  if (isLang(uiLang)) return uiLang;
  const base = uiLang.split('-')[0]?.toLowerCase();
  return isLang(base) ? base : fallback;
}

/**
 * Is `v` a Localized value (a plain object whose keys are content languages,
 * with every active language present as a string)? Tolerates future optional
 * language keys (see LANGS).
 */
export function isLocalizedValue(v: unknown): v is Localized {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return LANGS.every((l) => typeof o[l] === 'string') && Object.keys(o).every((k) => isLang(k) && typeof o[k] === 'string');
}

/**
 * A localized string: all three locale keys are present (an untranslated
 * locale is ''), and at least one is non-empty. Completeness of translations
 * is reported by `missingLangs` / `validatePackage`, not by the schema, so
 * drafts with gaps still parse.
 */
export const LocalizedSchema = z
  .object({ ky: z.string(), ru: z.string(), en: z.string() })
  .refine((v) => !!(v.ky || v.ru || v.en), {
    message: 'Localized value must have at least one language',
  });
export type Localized = z.infer<typeof LocalizedSchema>;

/** Build a Localized (handy for tests and admin forms). */
export const L = (ky: string, ru = ky, en = ru): Localized => ({ ky, ru, en });

/** Resolve a localized value: requested lang → ky → ru → en, skipping empty strings. */
export function t(value: Partial<Localized> | undefined, lang: Lang): string {
  if (!value) return '';
  for (const l of [lang, ...FALLBACK_CHAIN]) {
    const s = value[l];
    if (s) return s;
  }
  return '';
}

/** Languages whose string is empty or whitespace-only. */
export function missingLangs(value: Partial<Localized> | undefined): Lang[] {
  return LANGS.filter((l) => !value?.[l]?.trim());
}

/** Translation status of a string/locale (TZ §8 LocaleString.status, A-11). */
export const I18N_STATUSES = ['machine', 'draft', 'reviewed'] as const;
export const I18nStatusSchema = z.enum(I18N_STATUSES);
export type I18nStatus = z.infer<typeof I18nStatusSchema>;

/** Optional per-topic map `{ [locale]: status }`. Absent locale = unknown/untracked. */
export const I18nStatusMapSchema = z
  .object({
    ky: I18nStatusSchema.optional(),
    ru: I18nStatusSchema.optional(),
    en: I18nStatusSchema.optional(),
  })
  .strict();
export type I18nStatusMap = z.infer<typeof I18nStatusMapSchema>;

/** Locales that are not yet human-reviewed (for "machine draft" badges). */
export function unreviewedLangs(map: I18nStatusMap | undefined): Lang[] {
  return LANGS.filter((l) => map?.[l] !== 'reviewed');
}
