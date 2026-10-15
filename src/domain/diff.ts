/** Structural JSON diff for topic versions (A-13 «дифф с опубликованной версией»). */
export interface Change {
  path: (string | number)[];
  kind: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function diffJson(a: unknown, b: unknown, path: (string | number)[] = [], out: Change[] = [], max = 500): Change[] {
  if (out.length >= max) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (i >= a.length) out.push({ path: [...path, i], kind: 'added', after: b[i] });
      else if (i >= b.length) out.push({ path: [...path, i], kind: 'removed', before: a[i] });
      else diffJson(a[i], b[i], [...path, i], out, max);
    }
    return out;
  }
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in a) || a[k] === undefined) {
        if (b[k] !== undefined) out.push({ path: [...path, k], kind: 'added', after: b[k] });
      } else if (!(k in b) || b[k] === undefined) out.push({ path: [...path, k], kind: 'removed', before: a[k] });
      else diffJson(a[k], b[k], [...path, k], out, max);
    }
    return out;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path, kind: 'changed', before: a, after: b });
  return out;
}
