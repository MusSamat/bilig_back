/**
 * The concept dictionary (TZ §8 Concept, W-21, W-30/W-31, A-04) plus the
 * property-type dictionary that drives icons, value kinds and units.
 */
import { z } from 'zod';
import { HueSchema, KeySchema, Vec3Schema, type Vec3 } from './common.js';
import { LocalizedSchema, t, type Lang } from './i18n.js';

// ---------------------------------------------------------------------------
// Examples: real-world STEM applications + plain everyday analogies.
// ---------------------------------------------------------------------------

/** STEM field of a real-world example: Science / Technology / Engineering / Math. */
export const STEM_FIELDS = ['s', 't', 'e', 'm'] as const;
export const StemFieldSchema = z.enum(STEM_FIELDS);
export type StemField = z.infer<typeof StemFieldSchema>;

export const ExampleSchema = z.object({
  title: LocalizedSchema,
  text: LocalizedSchema,
  field: StemFieldSchema.optional(),
});
export type Example = z.infer<typeof ExampleSchema>;

/**
 * Every topic and every concept carries examples:
 *  - `stem`   — real-world Science/Technology/Engineering/Math applications;
 *  - `simple` — plain everyday analogies so a child understands.
 * Both lists are non-empty; all three languages are required by `validatePackage`.
 */
export const ExamplesSchema = z.object({
  stem: z.array(ExampleSchema).min(1),
  simple: z.array(ExampleSchema).min(1),
});
export type Examples = z.infer<typeof ExamplesSchema>;

// ---------------------------------------------------------------------------
// Property-type dictionary (W-31 «иконки — по типу свойства из словаря типов»).
// ---------------------------------------------------------------------------

export const PROPERTY_VALUE_KINDS = ['quantity', 'text', 'formula'] as const;
export const PropertyValueKindSchema = z.enum(PROPERTY_VALUE_KINDS);
export type PropertyValueKind = z.infer<typeof PropertyValueKindSchema>;

/** Property-type keys are camelCase identifiers (`atomicNumber`, `molarMass`). */
export const PropertyTypeKeySchema = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9]*$/, 'Invalid property type key');

export const PropertyTypeDefSchema = z.object({
  key: PropertyTypeKeySchema,
  label: LocalizedSchema,
  /** Icon id from the UI sprite. */
  icon: z.string().min(1),
  valueKind: PropertyValueKindSchema,
  /** Default unit for `quantity` values (a prop may override). */
  unit: z.string().optional(),
});
export type PropertyTypeDef = z.infer<typeof PropertyTypeDefSchema>;

const P = (
  key: string,
  icon: string,
  valueKind: PropertyValueKind,
  label: [string, string, string],
  unit?: string,
): PropertyTypeDef => ({
  key,
  icon,
  valueKind,
  unit,
  label: { ky: label[0], ru: label[1], en: label[2] },
});

/** Built-in property types. Packages may extend it via `ContentPackage.propertyTypes`. */
export const PROPERTY_TYPES: Readonly<Record<string, PropertyTypeDef>> = Object.freeze(
  Object.fromEntries(
    [
      P('size', 'ruler', 'quantity', ['Өлчөмү', 'Размер', 'Size'], 'µm'),
      P('location', 'map-pin', 'text', ['Жайгашкан жери', 'Где находится', 'Location']),
      P('foundIn', 'users', 'text', ['Кимде кездешет', 'У кого встречается', 'Found in']),
      P('analogy', 'lightbulb', 'text', ['Окшоштук', 'Аналогия', 'Analogy']),
      P('function', 'cog', 'text', ['Милдети', 'Функция', 'Function']),
      P('shape', 'shapes', 'text', ['Формасы', 'Форма', 'Shape']),
      P('count', 'hash', 'quantity', ['Саны', 'Количество', 'Count']),
      P('atomicNumber', 'atom', 'quantity', ['Атомдук номер', 'Атомный номер', 'Atomic number']),
      P('electronegativity', 'zap', 'quantity', ['Электр терс таасирдүүлүк', 'Электроотрицательность', 'Electronegativity']),
      P('formula', 'function-square', 'formula', ['Формула', 'Формула', 'Formula']),
      P('molarMass', 'scale', 'quantity', ['Молярдык масса', 'Молярная масса', 'Molar mass'], 'g/mol'),
      P('volume', 'box', 'quantity', ['Көлөмү', 'Объём', 'Volume'], 'cm³'),
      P('mass', 'weight', 'quantity', ['Массасы', 'Масса', 'Mass'], 'kg'),
      P('temperature', 'thermometer', 'quantity', ['Температура', 'Температура', 'Temperature'], '°C'),
      P('density', 'layers', 'quantity', ['Тыгыздыгы', 'Плотность', 'Density'], 'g/cm³'),
      P('meltingPoint', 'thermometer-snowflake', 'quantity', ['Эрүү температурасы', 'Температура плавления', 'Melting point'], '°C'),
      P('boilingPoint', 'thermometer-sun', 'quantity', ['Кайноо температурасы', 'Температура кипения', 'Boiling point'], '°C'),
      P('charge', 'plus-minus', 'quantity', ['Заряды', 'Заряд', 'Charge'], 'e'),
      P('bondAngle', 'triangle', 'quantity', ['Байланыш бурчу', 'Валентный угол', 'Bond angle'], '°'),
    ].map((d) => [d.key, d]),
  ),
);

/** Resolve a property type from the built-in dictionary plus package extensions. */
export function propertyType(
  key: string,
  extra: readonly PropertyTypeDef[] = [],
): PropertyTypeDef | undefined {
  return extra.find((d) => d.key === key) ?? PROPERTY_TYPES[key];
}

// ---------------------------------------------------------------------------
// Typed property values (W-30 «Свойства типизированы, формат чисел — Intl»).
// ---------------------------------------------------------------------------

export const ConceptPropSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('quantity'),
    type: PropertyTypeKeySchema,
    value: z.number().finite(),
    /** Upper bound for a range value (`value`–`max`). */
    max: z.number().finite().optional(),
    /** Overrides the dictionary unit. */
    unit: z.string().optional(),
    approx: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('text'), type: PropertyTypeKeySchema, value: LocalizedSchema }),
  /** TeX source, e.g. `H_2O`. */
  z.object({ kind: z.literal('formula'), type: PropertyTypeKeySchema, value: z.string().min(1) }),
]);
export type ConceptProp = z.infer<typeof ConceptPropSchema>;

/** Format a property value for display (numbers via Intl in the UI language). */
export function formatPropValue(
  prop: ConceptProp,
  lang: Lang,
  extra: readonly PropertyTypeDef[] = [],
): string {
  switch (prop.kind) {
    case 'text':
      return t(prop.value, lang);
    case 'formula':
      return prop.value;
    case 'quantity': {
      const nf = new Intl.NumberFormat(lang, { maximumFractionDigits: 4 });
      const unit = prop.unit ?? propertyType(prop.type, extra)?.unit;
      const num =
        (prop.approx ? '≈' : '') +
        nf.format(prop.value) +
        (prop.max !== undefined ? `–${nf.format(prop.max)}` : '');
      return unit ? `${num} ${unit}` : num;
    }
  }
}

// ---------------------------------------------------------------------------
// Concept
// ---------------------------------------------------------------------------

/** A typical student mistake (A-04), referenced by `Item.misconceptionKey`. */
export const MisconceptionSchema = z.object({
  key: KeySchema,
  text: LocalizedSchema,
  correction: LocalizedSchema,
});
export type Misconception = z.infer<typeof MisconceptionSchema>;

export const ConceptSchema = z.object({
  /** Global readable key, e.g. `bio.nucleus`. */
  key: KeySchema,
  /** Free-form category: `organelle`, `element`, `molecule`, `bond`, `solid`… */
  kind: z.string().min(1),
  /** Color-dot hue 0–359 (W-31). */
  hue: HueSchema,
  /** Shells (membrane, wall, faces) never steal clicks from inner structures (W-21). */
  isContainer: z.boolean(),
  title: LocalizedSchema,
  subtitle: LocalizedSchema.optional(),
  description: LocalizedSchema,
  props: z.array(ConceptPropSchema),
  /** Keys of related concepts («Связано с»). Must be present in the same package. */
  related: z.array(KeySchema),
  misconceptions: z.array(MisconceptionSchema),
  funFact: LocalizedSchema.optional(),
  analogy: LocalizedSchema.optional(),
  examples: ExamplesSchema,
});
export type Concept = z.infer<typeof ConceptSchema>;

/**
 * Per-topic override of a dictionary concept (W-31 «понятие + overrides темы»,
 * W-22 anchor, A-06 node binding / masks like `Mito_*`).
 */
export const ConceptOverrideSchema = ConceptSchema.pick({
  title: true,
  subtitle: true,
  description: true,
  hue: true,
  props: true,
  funFact: true,
  analogy: true,
  examples: true,
})
  .partial()
  .extend({
    /** Label/camera anchor in scene coordinates. */
    anchor: Vec3Schema.optional(),
    /** Scene node names or glob masks (`Mito_*`) bound to this concept. */
    nodes: z.array(z.string().min(1)).optional(),
  });
export type ConceptOverride = z.infer<typeof ConceptOverrideSchema>;

/** A concept as shown in a topic: dictionary entry merged with the topic override. */
export type ResolvedConcept = Concept & { anchor?: Vec3; nodes?: string[] };

/** Merge a topic override onto a dictionary concept (override wins field by field). */
export function applyOverride(concept: Concept, override?: ConceptOverride): ResolvedConcept {
  if (!override) return { ...concept };
  const out: ResolvedConcept = { ...concept };
  for (const [k, v] of Object.entries(override)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Glob match for node masks: `*` = any run, `?` = one char. */
export function matchesNodeMask(nodeName: string, mask: string): boolean {
  const re = new RegExp(
    '^' + mask.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
  );
  return re.test(nodeName);
}

/** Map a scene node name to the concept bound to it (first match wins). */
export function conceptForNode(
  nodeName: string,
  concepts: readonly ResolvedConcept[],
): string | null {
  for (const c of concepts) {
    if (c.nodes?.some((m) => matchesNodeMask(nodeName, m))) return c.key;
  }
  return null;
}

