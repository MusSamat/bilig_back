/** Cursor pagination helpers shared by repositories (cursor = opaque last sort value). */
import type { PageReq, PageRes } from './types.js';

export const encodeCursor = (v: string): string => Buffer.from(v, 'utf8').toString('base64url');

export function decodeCursor(c: string | undefined): string | undefined {
  if (!c) return undefined;
  try {
    const s = Buffer.from(c, 'base64url').toString('utf8');
    return s.length > 0 && s.length <= 2048 ? s : undefined;
  } catch {
    return undefined;
  }
}

/** Page an already sorted (ascending by `sortKey`) array. */
export function pageArray<T>(sorted: readonly T[], page: PageReq, sortKey: (t: T) => string): PageRes<T> {
  const after = decodeCursor(page.cursor);
  const start = after === undefined ? 0 : sorted.findIndex((t) => sortKey(t) > after);
  const from = start < 0 ? sorted.length : start;
  const slice = sorted.slice(from, from + page.limit);
  const more = from + page.limit < sorted.length;
  return {
    items: slice,
    nextCursor: more && slice.length ? encodeCursor(sortKey(slice[slice.length - 1])) : null,
  };
}

/** Clamp a client-provided limit. */
export const pageOf = (q: { cursor?: string; limit?: number }, def = 50, max = 100): PageReq => ({
  cursor: q.cursor,
  limit: Math.min(max, Math.max(1, q.limit ?? def)),
});

// ---------------------------------------------------------------------------
// Sorted pages (admin lists with `sort` / `order`): keyset over (value, tie).
// ---------------------------------------------------------------------------

export type SortValue = string | number | null | undefined;
export interface SortSpec<T> {
  value: (t: T) => SortValue;
  /** Unique tiebreaker (key or id). */
  tie: (t: T) => string;
  order?: 'asc' | 'desc';
}

const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'variant' });
type Tuple = [0 | 1, string | number, string];
const tupleOf = <T>(spec: SortSpec<T>, t: T): Tuple => {
  const v = spec.value(t);
  return v === null || v === undefined || v === '' ? [1, '', spec.tie(t)] : [0, v, spec.tie(t)];
};
/** Ascending comparison: present values first, numbers numerically, strings by collation, then the tie. */
function cmpTuple(a: Tuple, b: Tuple): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  const [x, y] = [a[1], b[1]];
  let c = 0;
  if (typeof x === 'number' && typeof y === 'number') c = x - y;
  else c = collator.compare(String(x), String(y));
  if (c !== 0) return c;
  return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0;
}

/**
 * Sort `rows` by `spec` and return one page. The cursor encodes the last
 * row's (value, tie), so pages stay stable while rows are added. `desc`
 * reverses the whole order (missing values first).
 */
export function sortedPage<T>(rows: readonly T[], spec: SortSpec<T>, page: PageReq): PageRes<T> {
  const dir = spec.order === 'desc' ? -1 : 1;
  const keyed = rows.map((r) => ({ r, k: tupleOf(spec, r) }));
  keyed.sort((a, b) => dir * cmpTuple(a.k, b.k));
  let start = 0;
  const raw = decodeCursor(page.cursor);
  if (raw !== undefined) {
    let after: Tuple | null = null;
    try {
      const p = JSON.parse(raw) as unknown;
      if (Array.isArray(p) && p.length === 3 && (p[0] === 0 || p[0] === 1) && typeof p[2] === 'string') after = p as Tuple;
    } catch {
      after = null;
    }
    if (after) {
      const i = keyed.findIndex((x) => dir * cmpTuple(x.k, after!) > 0);
      start = i < 0 ? keyed.length : i;
    }
  }
  const slice = keyed.slice(start, start + page.limit);
  const more = start + page.limit < keyed.length;
  return {
    items: slice.map((x) => x.r),
    nextCursor: more && slice.length ? encodeCursor(JSON.stringify(slice[slice.length - 1].k)) : null,
  };
}
