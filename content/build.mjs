#!/usr/bin/env node
/**
 * Bilig content build: assembles one ContentPackage per topic from the
 * authoring sources in content/src/ and writes the validated output to
 * content/packages/<topicKey>.json plus content/catalog.json.
 *
 *   npx tsx content/build.mjs           build + validate, write outputs
 *   npx tsx content/build.mjs --check   build + validate, fail if outputs are stale
 *   npx tsx content/build.mjs --partial validate only (no writes, no unit/subject coverage checks)
 *   npx tsx content/build.mjs --only=water,methane   validate just these topics (no writes)
 *
 * Sources (all plain JSON, see content/README.md):
 *   src/curriculum.json            groups, subjects, courses, units, objectives
 *   src/concepts/*.json            { concepts: Concept[] }        — the shared concept dictionary
 *   src/processes/*.json           { processes: Process[] }       — reusable processes
 *   src/glossary/<subject>.json    { glossary: GlossaryTerm[] }   — shipped with that subject's packages
 *   src/property-types/*.json      { propertyTypes: PropertyTypeDef[] } — extends PROPERTY_TYPES
 *   src/topics/<topicKey>.json     { topic: Topic, items: Item[], version?: semver }
 *   src/textbooks/<key>.json       { textbook: Textbook }         — chapters/lessons mapped onto topic keys (v0.5.0)
 *   assets/<topicKey>/<path>       binary files of manifest path <path> (real sha256/size), ASSET.json = licence/author/source
 *
 * Runs under tsx because it imports the TypeScript contract (@bilig/content-model).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CatalogSchema,
  PROPERTY_TYPES,
  PropertyTypeDefSchema,
  TextbookSchema,
  textbookTopicKeys,
  validatePackage,
} from '@bilig/content-model';

const ROOT = fileURLToPath(new URL('./', import.meta.url));
const SRC = join(ROOT, 'src');
const OUT = join(ROOT, 'packages');
/** Binary assets: content/assets/<topicKey>/<manifest path>, described by content/assets/<topicKey>/ASSET.json. */
const ASSETS = join(ROOT, 'assets');
/** TZ §10: topic package ≤ 5 MB; one GLB ≤ 3 MB (asset pipeline budget). */
const PACKAGE_BUDGET = 5 * 1024 * 1024;
const GLB_BUDGET = 3 * 1024 * 1024;
const CHECK = process.argv.includes('--check');
const PARTIAL = process.argv.includes('--partial') || process.argv.some((a) => a.startsWith('--only='));
/** Fixed build time keeps outputs reproducible; override with SOURCE_DATE (ISO). */
const BUILT_AT = process.env.SOURCE_DATE ?? '2026-10-15T00:00:00Z';
const DEFAULT_I18N = { ky: 'machine', ru: 'reviewed', en: 'draft' };

/** Parse a JSON source; a broken file is reported and skipped instead of aborting the build. */
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    problems.push(`ERROR ${p}: ${e.message}`);
    return null;
  }
};
const jsonFiles = (dir) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => join(dir, f)) : [];
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const problems = [];
/** --only a,b : validate just these topics (implies --partial). */
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.slice(7).split(',')) : null;
const fail = (where, msg) => problems.push(`ERROR ${where}: ${msg}`);
const warnings = [];

/** Index entities from all files of a directory, rejecting duplicate keys. */
function indexDir(dir, field, keyOf = (x) => x.key) {
  const map = new Map();
  const origin = new Map();
  for (const file of jsonFiles(dir)) {
    const list = readJson(file)?.[field];
    if (!Array.isArray(list)) {
      fail(file, `expected { "${field}": [...] }`);
      continue;
    }
    for (const x of list) {
      const k = keyOf(x);
      if (map.has(k)) fail(file, `duplicate ${field} key "${k}" (also in ${basename(origin.get(k))})`);
      map.set(k, x);
      origin.set(k, file);
    }
  }
  return { map, origin };
}

// --- load sources -----------------------------------------------------------
const cur = readJson(join(SRC, 'curriculum.json'));
const subjects = new Map(cur.subjects.map((s) => [s.key, s]));
const courses = new Map(cur.courses.map((c) => [c.key, c]));
const units = new Map(cur.units.map((u) => [u.key, u]));
const concepts = indexDir(join(SRC, 'concepts'), 'concepts').map;
const processes = indexDir(join(SRC, 'processes'), 'processes').map;
const propTypes = indexDir(join(SRC, 'property-types'), 'propertyTypes').map;
// v0.5.0: sample scenes default to the thumbnail specs, so a sample shows on the stage what its thumbnail shows.
const thumbSpecs = existsSync(join(SRC, 'thumbs.json')) ? readJson(join(SRC, 'thumbs.json')) : {};
const sampleSceneFromSpec = (spec) => {
  if (!spec) return undefined;
  const scene = {
    ...(spec.scene?.params ? { params: spec.scene.params } : {}),
    ...(spec.scene?.camera ? { camera: spec.scene.camera } : {}),
    ...(spec.modes ? { modes: spec.modes } : {}),
  };
  return Object.keys(scene).length ? scene : undefined;
};
for (const [k, def] of propTypes) {
  if (PROPERTY_TYPES[k]) fail('property-types', `"${k}" already exists in the built-in PROPERTY_TYPES`);
  const r = PropertyTypeDefSchema.safeParse(def);
  if (!r.success) fail(`property-types/${k}`, r.error.issues[0].message);
}
const glossaryBySubject = new Map();
const glossaryIds = new Set();
for (const file of jsonFiles(join(SRC, 'glossary'))) {
  const subject = basename(file, '.json');
  const list = readJson(file)?.glossary ?? [];
  for (const g of list) {
    if (glossaryIds.has(g.id)) fail(file, `duplicate glossary id "${g.id}"`);
    glossaryIds.add(g.id);
  }
  glossaryBySubject.set(subject, list);
}
const itemKeysSeen = new Map();

// --- assemble packages -------------------------------------------------------
const built = new Map();
const stats = { topics: 0, concepts: new Set(), processes: new Set(), items: 0, errors: 0, warnings: 0 };

/** Authoring rules stricter than the contract (user requirement: ≥2 stem + ≥2 simple examples). */
function checkExamplesRich(ex, where) {
  if (!ex) return fail(where, 'missing examples');
  if ((ex.stem?.length ?? 0) < 2) fail(where, 'needs ≥2 examples.stem');
  if ((ex.simple?.length ?? 0) < 2) fail(where, 'needs ≥2 examples.simple');
  ex.stem?.forEach((e, i) => {
    if (!['s', 't', 'e', 'm'].includes(e.field)) fail(where, `examples.stem[${i}] needs field s|t|e|m`);
  });
}

for (const file of jsonFiles(join(SRC, 'topics'))) {
  if (ONLY && !ONLY.has(basename(file, '.json'))) continue;
  const src = readJson(file);
  if (!src) continue;
  const topic = { ...src.topic };
  const where = `topics/${basename(file)}`;
  if (!topic?.key) {
    fail(where, 'missing topic.key');
    continue;
  }
  if (basename(file, '.json') !== topic.key) fail(where, `file name must be ${topic.key}.json`);
  topic.i18n ??= DEFAULT_I18N;
  for (const k of Object.keys(thumbSpecs[topic.key] ?? {}))
    if (!(topic.samples ?? []).some((smp) => smp.key === k)) fail(where, `thumbs.json names sample "${k}", which the topic does not have`);
  topic.samples = (topic.samples ?? []).map((smp) => {
    if (smp.scene) return smp;
    const scene = sampleSceneFromSpec(thumbSpecs[topic.key]?.[smp.key]);
    return scene ? { ...smp, scene } : smp;
  });
  const unit = units.get(topic.unitKey);
  const course = unit && courses.get(unit.courseKey);
  const subject = course && subjects.get(course.subjectKey);
  if (!unit || !course || !subject) {
    fail(where, `unit "${topic.unitKey}" is not in curriculum.json (unit → course → subject)`);
    continue;
  }
  const objectives = cur.objectives.filter((o) => o.unitKey === unit.key);
  const items = src.items ?? [];
  for (const it of items) {
    if (itemKeysSeen.has(it.key)) fail(where, `item key "${it.key}" also used in ${itemKeysSeen.get(it.key)}`);
    itemKeysSeen.set(it.key, where);
  }

  // processes of the topic
  const pkgProcesses = [];
  for (const k of topic.activities?.processKeys ?? []) {
    const p = processes.get(k);
    if (p) pkgProcesses.push(p);
    else fail(where, `process "${k}" not found in src/processes`);
  }

  // concepts: topic concepts + their related + step concepts + comparison concepts
  const topicKeys = topic.conceptKeys ?? [];
  const wanted = [...topicKeys];
  for (const k of topicKeys) wanted.push(...(concepts.get(k)?.related ?? []));
  for (const p of pkgProcesses) for (const s of p.steps) if (s.conceptKey) wanted.push(s.conceptKey);
  for (const c of topic.activities?.comparison?.columns ?? []) if (c.kind === 'concept') wanted.push(c.key);
  const keys = [...new Set(wanted)];
  const inPkg = new Set(keys);
  const pkgConcepts = [];
  for (const k of keys) {
    const c = concepts.get(k);
    if (!c) {
      fail(where, `concept "${k}" not found in src/concepts`);
      continue;
    }
    checkExamplesRich(c.examples, `concept ${k}`);
    // Concepts pulled in only as neighbours keep just the links that stay inside the package.
    pkgConcepts.push(topicKeys.includes(k) ? c : { ...c, related: c.related.filter((r) => inPkg.has(r)) });
  }
  checkExamplesRich(topic.examples, where);

  // extra property types actually used
  const usedTypes = new Set();
  for (const c of pkgConcepts) for (const p of c.props) usedTypes.add(p.type);
  for (const o of Object.values(topic.overrides ?? {})) for (const p of o.props ?? []) usedTypes.add(p.type);
  for (const r of topic.activities?.comparison?.rows ?? []) usedTypes.add(r);
  for (const p of topic.props ?? []) usedTypes.add(p.type);
  for (const smp of topic.samples ?? []) for (const p of smp.props ?? []) usedTypes.add(p.type);
  const extraTypes = [...usedTypes].filter((k) => propTypes.has(k)).sort().map((k) => propTypes.get(k));

  // manifest: scene asset + thumbnails. Files present in content/assets/<topicKey>/ get their real
  // sha256 and size; missing ones keep the placeholder (sha256("pending:<path>"), size 0).
  const paths = [...new Set([topic.scene?.asset, ...(topic.samples ?? []).map((s) => s.thumb)].filter(Boolean))];
  const assetFiles = topicAssets(topic.key, paths, where);
  const pkg = {
    manifest: {
      topicKey: topic.key,
      version: src.version ?? '1.0.0',
      hash: '0'.repeat(64),
      files: assetFiles,
      builtAt: BUILT_AT,
    },
    subject,
    course,
    unit,
    objectives,
    topic,
    concepts: pkgConcepts,
    processes: pkgProcesses,
    items,
    glossary: glossaryBySubject.get(subject.key) ?? [],
    ...(extraTypes.length ? { propertyTypes: extraTypes } : {}),
  };
  pkg.manifest.hash = sha256(JSON.stringify({ ...pkg, manifest: { ...pkg.manifest, hash: '' } }));

  const res = validatePackage(pkg);
  for (const i of res.issues) {
    const line = `${i.severity.toUpperCase()} ${topic.key} ${i.path.join('.')}: [${i.code}] ${i.message}`;
    if (i.severity === 'error') problems.push(line);
    else if (i.code !== 'machine_translation') warnings.push(line);
  }
  // authoring rules
  const types = new Set(items.map((i) => i.type));
  if ((topic.activities?.quiz?.itemKeys.length ?? 0) < 6) fail(where, 'quiz needs ≥6 items');
  const nSteps = topic.activities?.tour?.steps.length ?? 0;
  if (nSteps < 4 || nSteps > 8) fail(where, `tour needs 4–8 steps (has ${nSteps})`);
  if (types.size < 5) warnings.push(`WARN ${topic.key}: quiz uses ${types.size}/5 item types`);

  built.set(topic.key, pkg);
  stats.topics++;
  pkgConcepts.forEach((c) => stats.concepts.add(c.key));
  pkgProcesses.forEach((p) => stats.processes.add(p.key));
  stats.items += items.length;
}

/**
 * Manifest entries for a topic's files. A file that exists must be described
 * in ASSET.json (licence, author, source: TZ A-05); the package must stay
 * within the size budget.
 */
function topicAssets(topicKey, paths, where) {
  const dir = join(ASSETS, topicKey);
  const metaPath = join(dir, 'ASSET.json');
  const meta = existsSync(metaPath) ? readJson(metaPath) : null;
  const entries = new Map((meta?.files ?? []).map((f) => [f.path, f]));
  const files = [];
  for (const p of paths) {
    const abs = normalize(join(dir, p));
    if (relative(dir, abs).startsWith('..') || p === 'ASSET.json') {
      fail(where, `asset path "${p}" leaves content/assets/${topicKey}/`);
      continue;
    }
    if (!existsSync(abs)) {
      files.push({ path: p, hash: sha256(`pending:${p}`), size: 0 });
      continue;
    }
    const bytes = readFileSync(abs);
    files.push({ path: p, hash: sha256(bytes), size: bytes.length });
    const e = entries.get(p);
    if (!e || !e.license || !e.author || !e.source) {
      fail(where, `content/assets/${topicKey}/${p} needs an ASSET.json entry with license, author and source (TZ A-05)`);
      continue;
    }
    if (p.endsWith('.glb') && bytes.length > GLB_BUDGET) warnings.push(`WARN ${topicKey}: ${p} is ${bytes.length} bytes (GLB budget ${GLB_BUDGET})`);
  }
  for (const p of entries.keys()) if (!paths.includes(p)) warnings.push(`WARN ${topicKey}: ASSET.json lists "${p}", which the topic does not use`);
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > PACKAGE_BUDGET) fail(where, `assets total ${total} bytes (package budget ${PACKAGE_BUDGET}, TZ §10)`);
  return files;
}

// every unit must carry at least one topic; live subjects must have units
for (const u of PARTIAL ? [] : units.values()) {
  if (![...built.values()].some((p) => p.unit.key === u.key)) fail('curriculum.json', `unit "${u.key}" has no topic`);
}
for (const s of PARTIAL ? [] : subjects.values()) {
  const n = [...built.values()].filter((p) => p.subject.key === s.key).length;
  if (s.status === 'live' && n === 0) fail('curriculum.json', `live subject "${s.key}" has no topics`);
  if (s.status === 'soon' && n > 0) fail('curriculum.json', `subject "${s.key}" is "soon" but has topics`);
}

// --- textbooks (v0.5.0) ----------------------------------------------------------
// Schema + file name = key + chapter subjects; topic keys must exist among the
// built topics (skipped with --only / --partial, where not every topic is built).
const textbooks = [];
for (const file of jsonFiles(join(SRC, 'textbooks'))) {
  const where = `textbooks/${basename(file)}`;
  const src = readJson(file);
  if (!src) continue;
  const r = TextbookSchema.safeParse(src.textbook);
  if (!r.success) {
    fail(where, r.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    continue;
  }
  const tb = r.data;
  if (basename(file, '.json') !== tb.key) fail(where, `file name must equal the textbook key "${tb.key}"`);
  for (const c of tb.chapters) if (!subjects.has(c.subjectKey)) fail(where, `chapter "${c.key}": unknown subjectKey "${c.subjectKey}"`);
  if (!PARTIAL) for (const k of textbookTopicKeys(tb)) if (!built.has(k)) fail(where, `unknown topic "${k}"`);
  if (textbooks.some((x) => x.key === tb.key)) fail(where, `duplicate textbook key "${tb.key}"`);
  textbooks.push(tb);
}
textbooks.sort((a, b) => a.order - b.order || a.grade - b.grade || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

const catalog = { groups: cur.groups, subjects: cur.subjects, courses: cur.courses, units: cur.units, textbooks };
const cat = CatalogSchema.omit({ topics: true }).strict().safeParse(catalog);
if (!cat.success) fail('catalog', cat.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));

// --- output -------------------------------------------------------------------
const outputs = new Map([[join(ROOT, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n']]);
for (const [k, pkg] of built) outputs.set(join(OUT, `${k}.json`), JSON.stringify(pkg, null, 2) + '\n');
const stale = jsonFiles(OUT).filter((f) => !outputs.has(f));

warnings.forEach((w) => console.warn(w));
problems.forEach((p) => console.error(p));
const glossaryCount = [...glossaryBySubject.values()].reduce((n, l) => n + l.length, 0);
console.log(
  `topics=${stats.topics} concepts=${stats.concepts.size} (dictionary ${concepts.size}) processes=${stats.processes.size} ` +
    `items=${stats.items} glossary=${glossaryCount} textbooks=${textbooks.length} warnings=${warnings.length} errors=${problems.length}`,
);
if (problems.length) process.exit(1);
if (PARTIAL) process.exit(0);

if (CHECK) {
  const diff = [...outputs].filter(([p, s]) => !existsSync(p) || readFileSync(p, 'utf8') !== s).map(([p]) => p);
  if (diff.length || stale.length) {
    console.error(`Outputs are stale — run: npx tsx content/build.mjs\n${[...diff, ...stale].join('\n')}`);
    process.exit(1);
  }
  console.log('content is up to date');
} else {
  for (const [p, s] of outputs) writeFileSync(p, s);
  for (const f of stale) unlinkSync(f);
  console.log(`wrote ${outputs.size} files${stale.length ? `, removed ${stale.length} stale` : ''}`);
}
