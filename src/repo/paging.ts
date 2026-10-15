/** Cursor pagination helpers shared by repositories (cursor = opaque last sort value). */
import type { PageReq, PageRes } from './types.js';

export const encodeCursor = (v: string): string => Buffer.from(v, 'utf8').toString('base64url');

export function decodeCursor(c: string | undefined): string | undefined {
  if (!c) return undefined;
  try {
    const s = Buffer.from(c, 'base64url').toString('utf8');
    return s.length > 0 && s.length <= 512 ? s : undefined;
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
