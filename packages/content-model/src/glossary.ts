/** Glossary (TZ §8 GlossaryTerm, A-12): used by translators and the tutor. */
import { z } from 'zod';
import type { Lang } from './i18n.js';

export const GlossaryTermSchema = z.object({
  id: z.string().min(1),
  ky: z.string().min(1),
  ru: z.string().min(1),
  en: z.string().min(1),
  /** Forbidden variants (any language) that translators must not use. */
  forbidden: z.array(z.string().min(1)),
  /** Who approved the term (user id or name). */
  approvedBy: z.string().optional(),
});
export type GlossaryTerm = z.infer<typeof GlossaryTermSchema>;

export interface ForbiddenHit {
  termId: string;
  variant: string;
  /** The approved term in the requested language. */
  suggestion: string;
}

/** Find forbidden glossary variants used in a text (case-insensitive, word-ish match). */
export function findForbidden(
  text: string,
  glossary: readonly GlossaryTerm[],
  lang: Lang,
): ForbiddenHit[] {
  const lower = text.toLocaleLowerCase();
  const hits: ForbiddenHit[] = [];
  for (const term of glossary) {
    for (const variant of term.forbidden) {
      const v = variant.toLocaleLowerCase();
      const idx = lower.indexOf(v);
      if (idx < 0) continue;
      const before = idx === 0 ? '' : lower[idx - 1];
      const after = lower[idx + v.length] ?? '';
      const isWordChar = (c: string) => /[\p{L}\p{N}]/u.test(c);
      if ((before && isWordChar(before)) || (after && isWordChar(after))) continue;
      hits.push({ termId: term.id, variant, suggestion: term[lang] });
    }
  }
  return hits;
}
