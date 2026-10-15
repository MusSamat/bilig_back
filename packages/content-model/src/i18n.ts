/**
 * Languages, localized strings and per-locale translation status (TZ §1, A-11).
 */
import { z } from 'zod';

/** Contract version shared by @bilig/content-model and @bilig/permissions. */
export const CONTRACT_VERSION = '0.2.1';

export const LANGS = ['ky', 'ru', 'en'] as const;
export const LangSchema = z.enum(LANGS);
export type Lang = z.infer<typeof LangSchema>;
/** Kyrgyz is the primary UI/content language. */
export const DEFAULT_LANG: Lang = 'ky';
/** Fallback chain used by `t()` after the requested language. */
export const FALLBACK_CHAIN: readonly Lang[] = ['ky', 'ru', 'en'];

export const isLang = (v: unknown): v is Lang =>
  typeof v === 'string' && (LANGS as readonly string[]).includes(v);

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
