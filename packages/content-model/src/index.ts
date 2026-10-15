/**
 * @bilig/content-model — the shared, data-driven content contract (TZ §4
 * «Для масштаба», §8 «Модель данных»). Zod schemas are the source of truth;
 * every type is `z.infer` of its schema. API DTOs live in
 * `@bilig/content-model/api`.
 *
 * Core principle: no screen knows the name of any subject or topic. Subjects,
 * topics, scenes, concepts, processes and items are data; scenes are plugins.
 */
export * from './i18n.js';
export * from './common.js';
export * from './curriculum.js';
export * from './concept.js';
export * from './process.js';
export * from './item.js';
export * from './glossary.js';
export * from './topic.js';
export * from './scene-state.js';
export * from './package.js';
export * from './validate.js';
