/**
 * Package validation (TZ A-13 publish checklist, Stage-0 acceptance §11):
 * Zod schema + cross-reference checks. Returns a flat list of issues with
 * JSON paths so the admin can point at the exact field.
 */
import { type Example, type Examples, propertyType } from './concept.js';
import { LANGS, missingLangs } from './i18n.js';
import { ContentPackageSchema, type ContentPackage } from './package.js';

export type IssueSeverity = 'error' | 'warning';
export type IssuePath = (string | number)[];

export interface ValidationIssue {
  path: IssuePath;
  /** Stable machine code (`schema`, `concept_missing`, …). */
  code: string;
  message: string;
  severity: IssueSeverity;
}

export interface ValidationResult {
  /** True when there are no `error` issues (warnings allowed). */
  ok: boolean;
  issues: ValidationIssue[];
  /** The parsed package when the schema passed. */
  data?: ContentPackage;
}

/** Validate an untrusted package: schema first, then cross-references. */
export function validatePackage(input: unknown): ValidationResult {
  const parsed = ContentPackageSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        path: i.path,
        code: 'schema',
        message: i.message,
        severity: 'error' as const,
      })),
    };
  }
  const issues = crossCheckPackage(parsed.data);
  return { ok: !issues.some((i) => i.severity === 'error'), issues, data: parsed.data };
}

/** Throwing variant for loaders. */
export function assertValidPackage(input: unknown): ContentPackage {
  const res = validatePackage(input);
  if (!res.ok || !res.data) {
    const first = res.issues.find((i) => i.severity === 'error');
    throw new Error(
      `Invalid content package: ${first ? `${first.path.join('.')}: ${first.message}` : 'unknown'}` +
        ` (${res.issues.filter((i) => i.severity === 'error').length} errors)`,
    );
  }
  return res.data;
}

/** Examples must exist (schema) and be filled in all 3 languages. */
export function checkExamples(examples: Examples, path: IssuePath): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  (['stem', 'simple'] as const).forEach((kind) => {
    examples[kind].forEach((ex: Example, i) => {
      (['title', 'text'] as const).forEach((field) => {
        const missing = missingLangs(ex[field]);
        if (missing.length) {
          out.push({
            path: [...path, kind, i, field],
            code: 'example_translation_missing',
            message: `Example ${kind}[${i}].${field} missing: ${missing.join(', ')}`,
            severity: 'error',
          });
        }
      });
    });
  });
  return out;
}

/** Cross-reference checks on an already schema-valid package. */
export function crossCheckPackage(pkg: ContentPackage): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const err = (path: IssuePath, code: string, message: string) =>
    issues.push({ path, code, message, severity: 'error' });
  const warn = (path: IssuePath, code: string, message: string) =>
    issues.push({ path, code, message, severity: 'warning' });

  const { topic } = pkg;
  const extraTypes = pkg.propertyTypes ?? [];

  const dupes = (keys: string[], path: IssuePath, what: string) => {
    const seen = new Set<string>();
    keys.forEach((k, i) => {
      if (seen.has(k)) err([...path, i], 'duplicate_key', `Duplicate ${what} key "${k}"`);
      seen.add(k);
    });
  };

  const conceptKeys = new Set(pkg.concepts.map((c) => c.key));
  const topicConceptKeys = new Set(topic.conceptKeys);
  const processKeys = new Set(pkg.processes.map((p) => p.key));
  const itemKeys = new Set(pkg.items.map((i) => i.key));
  const sampleKeys = new Set(topic.samples.map((s) => s.key));
  const misconceptionKeys = new Set(pkg.concepts.flatMap((c) => c.misconceptions.map((m) => m.key)));

  dupes(pkg.concepts.map((c) => c.key), ['concepts'], 'concept');
  dupes(pkg.processes.map((p) => p.key), ['processes'], 'process');
  dupes(pkg.items.map((i) => i.key), ['items'], 'item');
  dupes(topic.conceptKeys, ['topic', 'conceptKeys'], 'topic concept');
  dupes(topic.samples.map((s) => s.key), ['topic', 'samples'], 'sample');
  dupes(pkg.glossary.map((g) => g.id), ['glossary'], 'glossary');

  // --- hierarchy ------------------------------------------------------------
  if (pkg.manifest.topicKey !== topic.key) {
    err(['manifest', 'topicKey'], 'manifest_topic_mismatch', `Manifest is for "${pkg.manifest.topicKey}"`);
  }
  if (pkg.unit && pkg.unit.key !== topic.unitKey) {
    err(['unit', 'key'], 'unit_mismatch', `Topic unit is "${topic.unitKey}"`);
  }
  if (pkg.course && pkg.unit && pkg.unit.courseKey !== pkg.course.key) {
    err(['unit', 'courseKey'], 'course_mismatch', `Unit course is "${pkg.unit.courseKey}"`);
  }
  if (pkg.course && pkg.course.subjectKey !== pkg.subject.key) {
    err(['course', 'subjectKey'], 'subject_mismatch', `Course subject is "${pkg.course.subjectKey}"`);
  }
  if (pkg.objectives) {
    const objKeys = new Set(pkg.objectives.map((o) => o.key));
    topic.objectiveKeys.forEach((k, i) => {
      if (!objKeys.has(k)) err(['topic', 'objectiveKeys', i], 'objective_missing', `Unknown objective "${k}"`);
    });
    pkg.items.forEach((item, ii) =>
      item.objectiveKeys.forEach((k, i) => {
        if (!objKeys.has(k)) warn(['items', ii, 'objectiveKeys', i], 'objective_missing', `Unknown objective "${k}"`);
      }),
    );
  }

  // --- concepts -------------------------------------------------------------
  topic.conceptKeys.forEach((k, i) => {
    if (!conceptKeys.has(k)) err(['topic', 'conceptKeys', i], 'concept_missing', `Concept "${k}" not in package`);
  });
  pkg.concepts.forEach((c, ci) => {
    c.related.forEach((r, ri) => {
      if (r === c.key) err(['concepts', ci, 'related', ri], 'related_self', 'Concept relates to itself');
      else if (!conceptKeys.has(r)) err(['concepts', ci, 'related', ri], 'related_missing', `Related "${r}" not in package`);
    });
    c.props.forEach((p, pi) => {
      const def = propertyType(p.type, extraTypes);
      if (!def) err(['concepts', ci, 'props', pi, 'type'], 'property_type_unknown', `Unknown property type "${p.type}"`);
      else if (def.valueKind !== p.kind)
        err(['concepts', ci, 'props', pi, 'kind'], 'property_kind_mismatch', `"${p.type}" expects ${def.valueKind}`);
    });
    issues.push(...checkExamples(c.examples, ['concepts', ci, 'examples']));
  });
  // v0.3.0: topic-level and sample properties use the same property-type dictionary.
  const checkProps = (props: readonly { type: string; kind: string }[] | undefined, path: (string | number)[]) =>
    props?.forEach((p, pi) => {
      const def = propertyType(p.type, extraTypes);
      if (!def) err([...path, pi, 'type'], 'property_type_unknown', `Unknown property type "${p.type}"`);
      else if (def.valueKind !== p.kind) err([...path, pi, 'kind'], 'property_kind_mismatch', `"${p.type}" expects ${def.valueKind}`);
    });
  checkProps(topic.props, ['topic', 'props']);
  topic.samples.forEach((s, si) => checkProps(s.props, ['topic', 'samples', si, 'props']));
  Object.entries(topic.overrides).forEach(([k, o]) => {
    if (!topicConceptKeys.has(k)) err(['topic', 'overrides', k], 'override_unknown', `Override for "${k}" not in topic.conceptKeys`);
    o.props?.forEach((p, pi) => {
      if (!propertyType(p.type, extraTypes))
        err(['topic', 'overrides', k, 'props', pi, 'type'], 'property_type_unknown', `Unknown property type "${p.type}"`);
    });
    if (o.examples) issues.push(...checkExamples(o.examples, ['topic', 'overrides', k, 'examples']));
  });

  // --- scene ----------------------------------------------------------------
  if (topic.scene.asset && !pkg.manifest.files.some((f) => f.path === topic.scene.asset)) {
    warn(['topic', 'scene', 'asset'], 'asset_not_in_manifest', `"${topic.scene.asset}" not listed in manifest.files`);
  }

  // --- processes ------------------------------------------------------------
  const acts = topic.activities;
  acts.processKeys.forEach((k, i) => {
    if (!processKeys.has(k)) err(['topic', 'activities', 'processKeys', i], 'process_missing', `Process "${k}" not in package`);
  });
  pkg.processes.forEach((p, pi) => {
    if (!acts.processKeys.includes(p.key)) warn(['processes', pi], 'process_unused', `Process "${p.key}" not used by topic`);
    dupes(p.steps.map((s) => s.key), ['processes', pi, 'steps'], 'step');
    dupes(p.metrics.map((m) => m.key), ['processes', pi, 'metrics'], 'metric');
    p.steps.forEach((s, si) => {
      if (s.conceptKey && !conceptKeys.has(s.conceptKey))
        err(['processes', pi, 'steps', si, 'conceptKey'], 'concept_missing', `Concept "${s.conceptKey}" not in package`);
    });
  });

  // --- comparison -----------------------------------------------------------
  if (acts.comparison) {
    const cmp = acts.comparison;
    cmp.columns.forEach((col, i) => {
      const ok = col.kind === 'concept' ? conceptKeys.has(col.key) : sampleKeys.has(col.key);
      if (!ok) err(['topic', 'activities', 'comparison', 'columns', i], 'column_missing', `${col.kind} "${col.key}" not found`);
    });
    cmp.rows.forEach((r, i) => {
      if (!propertyType(r, extraTypes))
        err(['topic', 'activities', 'comparison', 'rows', i], 'property_type_unknown', `Unknown property type "${r}"`);
    });
    const colKeys = new Set(cmp.columns.map((c) => c.key));
    cmp.manual?.forEach((m, i) => {
      if (!colKeys.has(m.column)) err(['topic', 'activities', 'comparison', 'manual', i, 'column'], 'column_missing', `Column "${m.column}" not in comparison`);
      if (!cmp.rows.includes(m.row)) err(['topic', 'activities', 'comparison', 'manual', i, 'row'], 'row_missing', `Row "${m.row}" not in comparison`);
      const concept = pkg.concepts.find((c) => c.key === m.column);
      if (concept?.props.some((p) => p.type === m.row))
        warn(['topic', 'activities', 'comparison', 'manual', i], 'manual_shadows_dictionary', `"${m.column}" already has "${m.row}" in the dictionary`);
    });
  }

  // --- quiz & items -----------------------------------------------------------
  acts.quiz?.itemKeys.forEach((k, i) => {
    if (!itemKeys.has(k)) err(['topic', 'activities', 'quiz', 'itemKeys', i], 'item_missing', `Item "${k}" not in package`);
  });
  pkg.items.forEach((item, ii) => {
    const at = (...p: IssuePath): IssuePath => ['items', ii, ...p];
    if (item.misconceptionKey && !misconceptionKeys.has(item.misconceptionKey))
      err(at('misconceptionKey'), 'misconception_missing', `Misconception "${item.misconceptionKey}" not found`);
    switch (item.type) {
      case 'single':
      case 'multiple': {
        const opts = item.options.map((o) => o.key);
        dupes(opts, at('options'), 'option');
        const answers = item.type === 'single' ? [item.answer] : item.answer;
        answers.forEach((a, ai) => {
          if (!opts.includes(a))
            err(item.type === 'single' ? at('answer') : at('answer', ai), 'answer_not_in_options', `Answer "${a}" is not an option`);
        });
        if (item.type === 'multiple') dupes(item.answer, at('answer'), 'answer');
        break;
      }
      case 'match':
        dupes(item.pairs.map((p) => p.key), at('pairs'), 'pair');
        break;
      case 'find-on-model':
        if (!topicConceptKeys.has(item.targetConceptKey))
          err(at('targetConceptKey'), 'concept_missing', `Target "${item.targetConceptKey}" not in topic`);
        break;
      case 'numeric':
        break;
    }
  });

  // --- tour -----------------------------------------------------------------
  acts.tour?.steps.forEach((s, si) => {
    const at = (...p: IssuePath): IssuePath => ['topic', 'activities', 'tour', 'steps', si, ...p];
    if (s.focus && !topicConceptKeys.has(s.focus)) err(at('focus'), 'concept_missing', `Focus "${s.focus}" not in topic`);
    (['isolate', 'hide'] as const).forEach((k) =>
      s.visibility?.[k]?.forEach((ck, i) => {
        if (!topicConceptKeys.has(ck)) err(at('visibility', k, i), 'concept_missing', `"${ck}" not in topic`);
      }),
    );
    if (s.sample && !sampleKeys.has(s.sample)) err(at('sample'), 'sample_missing', `Sample "${s.sample}" not in topic`);
    if (missingLangs(s.altText).length) warn(at('altText'), 'alt_text_incomplete', 'Alt text not in all languages');
  });
  if (acts.tour) dupes(acts.tour.steps.map((s) => s.key), ['topic', 'activities', 'tour', 'steps'], 'tour step');

  // --- examples on the topic ---------------------------------------------------
  issues.push(...checkExamples(topic.examples, ['topic', 'examples']));

  // --- unused concepts (package should carry only what is used) --------------
  const used = new Set<string>(topic.conceptKeys);
  pkg.concepts.forEach((c) => {
    if (topicConceptKeys.has(c.key)) c.related.forEach((r) => used.add(r));
  });
  pkg.processes.forEach((p) => p.steps.forEach((s) => s.conceptKey && used.add(s.conceptKey)));
  acts.comparison?.columns.forEach((c) => c.kind === 'concept' && used.add(c.key));
  pkg.concepts.forEach((c, ci) => {
    if (!used.has(c.key)) warn(['concepts', ci], 'concept_unused', `Concept "${c.key}" is not used by the topic`);
  });

  // --- i18n status sanity -------------------------------------------------------
  if (topic.i18n) {
    for (const l of LANGS) {
      if (topic.i18n[l] === 'machine') warn(['topic', 'i18n', l], 'machine_translation', `${l} is a machine draft`);
    }
  }

  return issues;
}
