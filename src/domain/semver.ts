/** Semver helpers for topic versions. */
export function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a) ?? [0, 0, 0];
  const pb = parseSemver(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}
/** Next patch version after the highest of `versions` (1.0.0 when none). */
export function nextVersion(versions: readonly string[]): string {
  if (!versions.length) return '1.0.0';
  const top = [...versions].sort(compareSemver).pop()!;
  const [ma, mi, pa] = parseSemver(top) ?? [1, 0, -1];
  return `${ma}.${mi}.${pa + 1}`;
}
