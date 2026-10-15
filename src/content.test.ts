/**
 * Seed content checks (TZ §11 stage 0: «11 тем прототипа проходят валидацию схем»).
 * Packages in content/packages are the build output of content/src (content/build.mjs).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CatalogSchema,
  ITEM_TYPES,
  LANGS,
  validatePackage,
  type ContentPackage,
  type Examples,
} from '@bilig/content-model';
import { loadContentRepo } from './content-repo.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CONTENT = join(ROOT, 'content');
const PKG_DIR = join(CONTENT, 'packages');

const files = readdirSync(PKG_DIR).filter((f) => f.endsWith('.json')).sort();
const raw = files.map((f) => ({ file: f, json: JSON.parse(readFileSync(join(PKG_DIR, f), 'utf8')) as unknown }));
const packages: ContentPackage[] = raw.map(({ json }) => json as ContentPackage);
const catalog = CatalogSchema.omit({ topics: true }).parse(
  JSON.parse(readFileSync(join(CONTENT, 'catalog.json'), 'utf8')),
);

/** Both example lists have ≥2 entries, each filled in all three languages. */
function examplesProblems(ex: Examples | undefined, where: string): string[] {
  if (!ex) return [`${where}: no examples`];
  const out: string[] = [];
  for (const kind of ['stem', 'simple'] as const) {
    if ((ex[kind]?.length ?? 0) < 2) out.push(`${where}: ${kind} has ${ex[kind]?.length ?? 0} < 2`);
    ex[kind]?.forEach((e, i) => {
      for (const f of ['title', 'text'] as const)
        for (const l of LANGS) if (!e[f]?.[l]?.trim()) out.push(`${where}: ${kind}[${i}].${f}.${l} empty`);
      if (kind === 'stem' && !e.field) out.push(`${where}: stem[${i}] has no s/t/e/m field`);
    });
  }
  return out;
}

describe('content packages', () => {
  it('there are at least 11 topics (stage-0 criterion) and at least 18 in total', () => {
    expect(packages.length).toBeGreaterThanOrEqual(18);
  });

  it.each(raw.map((r) => [r.file, r.json] as const))('%s validates with zero errors', (file, json) => {
    const res = validatePackage(json);
    const errors = res.issues.filter((i) => i.severity === 'error');
    expect(errors, JSON.stringify(errors.slice(0, 5), null, 2)).toEqual([]);
    expect(res.ok).toBe(true);
    expect(file).toBe(`${res.data!.topic.key}.json`);
  });

  it('every topic and every concept has stem + simple examples in ky, ru and en', () => {
    const problems = packages.flatMap((p) => [
      ...examplesProblems(p.topic.examples, `topic ${p.topic.key}`),
      ...p.concepts.flatMap((c) => examplesProblems(c.examples, `${p.topic.key}/${c.key}`)),
    ]);
    expect(problems).toEqual([]);
  });

  it('a shared concept is identical in every package that carries it (one dictionary)', () => {
    const seen = new Map<string, string>();
    const clash: string[] = [];
    for (const p of packages)
      for (const c of p.concepts) {
        const { related: _r, ...body } = c;
        const s = JSON.stringify(body);
        if (seen.has(c.key) && seen.get(c.key) !== s) clash.push(`${c.key} differs in ${p.topic.key}`);
        seen.set(c.key, s);
      }
    expect(clash).toEqual([]);
  });

  it('the item bank uses all five item types and every quiz has ≥6 items', () => {
    const types = new Set(packages.flatMap((p) => p.items.map((i) => i.type)));
    expect([...types].sort()).toEqual([...ITEM_TYPES].sort());
    for (const p of packages) expect(p.topic.activities.quiz?.itemKeys.length ?? 0).toBeGreaterThanOrEqual(6);
    const keys = packages.flatMap((p) => p.items.map((i) => i.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('the glossary has at least 40 terms with unique ids', () => {
    const ids = new Set(packages.flatMap((p) => p.glossary.map((g) => g.id)));
    expect(ids.size).toBeGreaterThanOrEqual(40);
  });
});

describe('catalog.json', () => {
  it('references exactly the existing packages', () => {
    const units = new Map(catalog.units.map((u) => [u.key, u]));
    const courses = new Map(catalog.courses.map((c) => [c.key, c]));
    const subjects = new Map(catalog.subjects.map((s) => [s.key, s]));
    for (const p of packages) {
      expect(units.get(p.topic.unitKey), p.topic.key).toEqual(p.unit);
      expect(courses.get(p.unit!.courseKey), p.topic.key).toEqual(p.course);
      expect(subjects.get(p.course!.subjectKey), p.topic.key).toEqual(p.subject);
    }
    // no dangling catalog entries: every unit has a topic, every course a unit
    const usedUnits = new Set(packages.map((p) => p.topic.unitKey));
    expect(catalog.units.filter((u) => !usedUnits.has(u.key)).map((u) => u.key)).toEqual([]);
    const usedCourses = new Set(catalog.units.map((u) => u.courseKey));
    expect(catalog.courses.filter((c) => !usedCourses.has(c.key)).map((c) => c.key)).toEqual([]);
    for (const s of catalog.subjects) {
      const n = packages.filter((p) => p.subject.key === s.key).length;
      if (s.status === 'live') expect(n, s.key).toBeGreaterThanOrEqual(3);
      else expect(n, s.key).toBe(0);
    }
    const groups = new Set(catalog.groups.map((g) => g.key));
    for (const s of catalog.subjects) expect(groups.has(s.group), s.key).toBe(true);
  });

  it('the server catalog lists one summary per package', () => {
    const repo = loadContentRepo();
    expect(repo.catalog().topics.map((t) => t.key).sort()).toEqual(packages.map((p) => p.topic.key).sort());
  });

  it('packages are up to date with content/src (build --check)', () => {
    const tsx = join(ROOT, 'node_modules', '.bin', 'tsx');
    expect(() =>
      execFileSync(tsx, [join(CONTENT, 'build.mjs'), '--check'], { cwd: ROOT, stdio: 'pipe' }),
    ).not.toThrow();
  }, 60_000);
});
