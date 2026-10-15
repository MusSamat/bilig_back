/**
 * Localized-string projection for the translation workspace (A-11). Content
 * documents keep Localized values inline; this module walks a document and
 * yields one row per (string key, locale). Keys look like
 * `concept/bio.nucleus/title` or `topic/animal-cell/activities.tour.steps.0.text`.
 */
import { LANGS, isLocalizedValue, type Lang, type Localized } from '@bilig/content-model';
import { sha256Hex } from './crypto.js';

export interface ExtractedString {
  key: string;
  path: (string | number)[];
  value: Localized;
}

/** Localized value (contract helper; tolerates future optional languages). */
const isLocalized = (v: unknown): v is Localized => isLocalizedValue(v);

export function extractLocalized(doc: unknown, path: (string | number)[] = []): { path: (string | number)[]; value: Localized }[] {
  if (isLocalized(doc)) return [{ path, value: doc }];
  if (Array.isArray(doc)) return doc.flatMap((x, i) => extractLocalized(x, [...path, i]));
  if (doc && typeof doc === 'object') return Object.entries(doc).flatMap(([k, v]) => extractLocalized(v, [...path, k]));
  return [];
}

/** Path segments are joined with `.`; a literal `.` or `~` inside a segment (e.g. an override keyed `bio.nucleus`) is escaped as `~1` / `~0`. */
const escSeg = (p: string | number) => String(p).replace(/~/g, '~0').replace(/\./g, '~1');
const unescSeg = (p: string) => p.replace(/~1/g, '.').replace(/~0/g, '~');

export const stringKey = (kind: string, entityKey: string, path: (string | number)[]) => `${kind}/${entityKey}/${path.map(escSeg).join('.')}`;

export function parseStringKey(key: string): { kind: string; entityKey: string; path: (string | number)[] } | null {
  const m = /^([a-z]+)\/([^/]+)\/(.+)$/.exec(key);
  if (!m) return null;
  return { kind: m[1], entityKey: m[2], path: m[3].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : unescSeg(p))) };
}

export function extractStrings(kind: string, entityKey: string, doc: unknown): ExtractedString[] {
  return extractLocalized(doc).map(({ path, value }) => ({ key: stringKey(kind, entityKey, path), path, value }));
}

/** Hash of the source text a translation was made from (A-11 «изменился источник»). */
export const sourceHash = (s: string) => sha256Hex(s).slice(0, 16);
export const SOURCE_LANG: Lang = 'ru';

/** All text of a document, lower-cased (admin search). */
export function searchTextOf(doc: unknown): string {
  return extractLocalized(doc)
    .flatMap(({ value }) => LANGS.map((l) => value[l]))
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase()
    .slice(0, 20_000);
}

/** Immutable set at a JSON path (returns a new document). */
export function setAtPath<T>(doc: T, path: (string | number)[], value: unknown): T {
  if (path.length === 0) return value as T;
  const [head, ...rest] = path;
  if (Array.isArray(doc)) {
    const copy = [...doc];
    copy[head as number] = setAtPath(copy[head as number], rest, value);
    return copy as T;
  }
  const obj = (doc ?? {}) as Record<string, unknown>;
  return { ...obj, [head]: setAtPath(obj[head as string], rest, value) } as T;
}

export function getAtPath(doc: unknown, path: (string | number)[]): unknown {
  let cur: unknown = doc;
  for (const p of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[p];
  }
  return cur;
}
