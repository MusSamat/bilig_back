/**
 * @bilig/content-model — the data-driven content schema (TZ §4 "Для масштаба").
 *
 * Core principle: no screen knows the name of any subject or topic. Everything —
 * subjects, topics, scenes, concepts, processes, the viewer's modes — is built
 * from data and plugins. The engine must stay stable from 1 to any number of
 * subjects (TZ test: 20 subjects / 2000 topics must not slow the catalog).
 */

/** Supported UI/content languages. Kyrgyz is primary (TZ: ky/ru/en). */
export type Lang = 'ky' | 'ru' | 'en';
export const LANGS: Lang[] = ['ky', 'ru', 'en'];
export const DEFAULT_LANG: Lang = 'ky';

/** A localized string. Keys are locale codes; `ky` is the source of truth. */
export type Localized = Partial<Record<Lang, string>>;

/** Resolve a localized value with ky → ru → en → first-available fallback. */
export function t(value: Localized | undefined, lang: Lang): string {
  if (!value) return '';
  return (
    value[lang] ??
    value.ky ??
    value.ru ??
    value.en ??
    Object.values(value)[0] ??
    ''
  );
}

/** Scene plugin kind (TZ W-25: "3D по типу сцены"). The engine dispatches on this. */
export type PluginType = 'glb' | 'molecule' | 'crystal' | 'geometry' | 'sim';

/** Subject status in the catalog (TZ W-02: статус «Скоро» с замком). */
export type SubjectStatus = 'available' | 'coming';

/**
 * A subject (e.g. biology). The catalog is built entirely from these records;
 * groups and colors are data, not layout (TZ W-02, W-03).
 */
export interface Subject {
  id: string;
  slug: string;
  title: Localized;
  /** Lucide-style icon id, resolved by the UI icon registry. */
  icon: string;
  /** Single hue 0–359; all interface tokens derive from it (TZ W-03). */
  hue: number;
  /** Catalog group id (e.g. "natural"). Groups are data. */
  group: string;
  status: SubjectStatus;
}

/** A catalog group (TZ W-02: естественные, точные, Земля и космос). */
export interface SubjectGroup {
  id: string;
  title: Localized;
  order: number;
}

/** A node in the course tree: subject → section → topic, arbitrary depth (TZ W-04). */
export interface CourseNode {
  id: string;
  parentId: string | null;
  subjectId: string;
  slug: string;
  title: Localized;
  /** Ordered position among siblings. */
  order: number;
  /** When set, this node is a leaf topic and `topicId` points to its content. */
  topicId?: string;
}

/** One property of a concept (TZ W-31: size, atomic number, formula, …). Typed, not free text. */
export interface ConceptProperty {
  /** Key into the property-type dictionary (drives icon + number format). */
  type: string;
  label: Localized;
  /** Raw value; numeric values are formatted via Intl per language (TZ W-30). */
  value: string | number;
  unit?: string;
}

/**
 * A concept = a structure/idea bound to the scene (TZ W-21, W-31).
 * `container` marks shells (membrane, wall, faces) that must NOT intercept
 * clicks meant for inner structures (TZ W-21: "Флаг container у понятия").
 */
export interface Concept {
  id: string;
  slug: string;
  title: Localized;
  subtitle?: Localized;
  description: Localized;
  /** Shell flag — see TZ W-21. */
  container: boolean;
  /** Accent color dot; if absent the UI derives one. */
  colorHue?: number;
  properties: ConceptProperty[];
  fact?: Localized;
  /** Ids of related concepts ("Связано с", TZ W-31). */
  relatedIds: string[];
  /** Optional explicit label/camera anchor in the model (TZ W-22). */
  anchor?: [number, number, number];
}

/** A step of a process (TZ W-42). References a concept by id. */
export interface ProcessStep {
  index: number;
  title: Localized;
  description: Localized;
  /** Concept id whose structure this step highlights in 3D. */
  conceptId?: string;
  /** Result/output summary of the step. */
  result?: Localized;
  altText?: Localized;
}

/** Process engine kind (TZ W-41: timeline | stoich | ode). */
export type ProcessEngine = 'timeline' | 'stoich' | 'ode';

/** A process/simulation attached to a topic (TZ §4.5). Reusable across topics (TZ W-40). */
export interface Process {
  id: string;
  title: Localized;
  description: Localized;
  equation?: string; // bare TeX
  engine: ProcessEngine;
  steps: ProcessStep[];
  /** Metric ids the engine's readouts() will emit (TZ W-43). */
  metrics: string[];
}

/** The 3D scene spec for a topic (TZ W-23/W-25). */
export interface SceneSpec {
  plugin: PluginType;
  /** Package-relative model ref for `glb`; generator params for others. */
  modelRef?: string;
  /** Mode ids this scene exposes; the panel is built from these (TZ W-23). */
  modes: string[];
  /** Per-concept overrides for this scene (anchors, visibility, color). */
  overrides?: Record<string, Partial<Pick<Concept, 'anchor' | 'colorHue'>>>;
}

/** A single quiz question (TZ: tests with saved results). */
export interface QuizQuestion {
  id: string;
  prompt: Localized;
  options: { id: string; text: Localized }[];
  correctOptionId: string;
  /** Concept this question relates to, for analytics ("самые сложные вопросы"). */
  conceptId?: string;
}

/** A comparison table spec (TZ W-44). Rows are built from concept properties. */
export interface ComparisonSpec {
  /** Concept ids (or sample ids) to place as columns. */
  columnConceptIds: string[];
  /** Property types to compare as rows. */
  propertyTypes: string[];
}

/** A full topic — the unit a student opens (TZ W-10..W-12, §4.5). */
export interface Topic {
  id: string;
  subjectId: string;
  slug: string;
  grade?: string; // e.g. "g7"
  title: Localized; // may carry a formula marker, e.g. "Вода, H₂O"
  classification?: Localized; // shown in italics (TZ W-10)
  description: Localized;
  goal?: Localized; // "Цель урока"
  /** KR program code this topic maps to (TZ W-10: "цель связана с кодами программы КР"). */
  programCode?: string;
  scene: SceneSpec;
  concepts: Concept[];
  processes: Process[];
  comparison?: ComparisonSpec;
  quiz?: QuizQuestion[];
}

/** A glossary entry (ky ↔ ru ↔ en, TZ: единый словарь понятий). */
export interface GlossaryEntry {
  id: string;
  term: Localized;
  definition: Localized;
  conceptId?: string;
}

/**
 * A content package — the offline unit (TZ: "офлайн по пакетам").
 * The whole thing is cached by the PWA for offline use.
 */
export interface ContentPackage {
  version: string;
  subject: Subject;
  topics: Topic[];
  glossary: GlossaryEntry[];
  /** Pre-rendered search index for the offline assistant (TZ W-32: MiniSearch). */
  searchDocs?: { id: string; title: string; body: string; lang: Lang }[];
}

/** Catalog payload the client fetches to build the subject modal (TZ W-02). */
export interface Catalog {
  groups: SubjectGroup[];
  subjects: Subject[];
}

// Zod validation schemas built from these types (TZ §7/§8).
export * from './schema.js';
