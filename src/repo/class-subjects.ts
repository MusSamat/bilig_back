/** v0.8.0: a class's subjects — `subjectKeys` wins; `subjectKey` stays the first one. */
import type { ClassRec } from './types.js';

export function classSubjects(next: Pick<ClassRec, 'subjectKey' | 'subjectKeys'>, prev?: Pick<ClassRec, 'subjectKey' | 'subjectKeys'>): { subjectKey: string | null; subjectKeys: string[] } {
  if (next.subjectKeys !== undefined) {
    const keys = [...new Set(next.subjectKeys)];
    return { subjectKey: keys[0] ?? null, subjectKeys: keys };
  }
  if (next.subjectKey !== undefined) {
    if (!next.subjectKey) return { subjectKey: null, subjectKeys: [] };
    const rest = (prev?.subjectKeys ?? []).filter((k) => k !== next.subjectKey);
    return { subjectKey: next.subjectKey, subjectKeys: [next.subjectKey, ...rest] };
  }
  const keys = prev?.subjectKeys ?? (prev?.subjectKey ? [prev.subjectKey] : []);
  return { subjectKey: keys[0] ?? null, subjectKeys: keys };
}
