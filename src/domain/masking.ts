/**
 * PII masking before anything leaves for the LLM provider (TZ §6: «Имена и
 * телефоны в тексте вопроса маскируются до отправки»). Masks phone numbers,
 * e-mails, explicit self-introductions in ky/ru/en and any known names
 * (the asking user's and their classmates').
 */
const PHONE = /(?:\+?\d[\d\s\-().]{7,}\d)/g;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
const NAME_WORD = "[\\p{Lu}][\\p{Ll}\\p{M}'’-]+";
const INTRO = new RegExp(
  String.raw`((?<![\p{L}])(?:[Мм]еня зовут|[Мм]о[её] имя|[Яя]\s*[-—]|[Mm]y name is|I am|I'm|i'm|[Мм]енин атым|[Аа]тым)\s+)(${NAME_WORD}(?:\s+${NAME_WORD})?)`,
  'gu',
);

export const NAME_MASK = '[имя]';
export const PHONE_MASK = '[телефон]';
export const EMAIL_MASK = '[email]';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function maskPii(text: string, knownNames: readonly string[] = []): string {
  let out = text.replace(EMAIL, EMAIL_MASK).replace(PHONE, (m) => (m.replace(/\D/g, '').length >= 9 ? PHONE_MASK : m));
  out = out.replace(INTRO, (_m, intro: string) => `${intro}${NAME_MASK}`);
  const parts = new Set<string>();
  for (const n of knownNames) {
    for (const p of n.split(/\s+/)) if ([...p].length >= 3) parts.add(p);
  }
  for (const p of [...parts].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(p)}(?![\\p{L}\\p{N}])`, 'giu'), NAME_MASK);
  }
  return out;
}
