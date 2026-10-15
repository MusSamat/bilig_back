/**
 * Content repository (TZ §4 "Для масштаба": catalog & packages are data).
 *
 * In the MVP packages are in-memory fixtures; later this reads built content
 * packages produced by the admin (apps/admin) + worker (apps/worker) pipeline.
 * The catalog is derived from the available packages so adding a subject is a
 * data change, never a code change (TZ W-02).
 */
import type { Catalog, ContentPackage, SubjectGroup } from '@bilig/content-model';
import { animalCellPackage } from '@bilig/content-model/fixtures/animal-cell';

/** Catalog groups (TZ W-02: естественные, точные, Земля и космос). Data, not layout. */
const GROUPS: SubjectGroup[] = [
  { id: 'natural', title: { ky: 'Табигый', ru: 'Естественные', en: 'Natural' }, order: 0 },
  { id: 'exact', title: { ky: 'Так илимдер', ru: 'Точные', en: 'Exact' }, order: 1 },
  { id: 'earth-space', title: { ky: 'Жер жана космос', ru: 'Земля и космос', en: 'Earth & Space' }, order: 2 },
];

/** Available content packages, keyed by subject id. */
const PACKAGES: Record<string, ContentPackage> = {
  [animalCellPackage.subject.id]: animalCellPackage,
};

export function getCatalog(): Catalog {
  const subjects = Object.values(PACKAGES).map((p) => p.subject);
  // A "coming soon" subject demonstrates the locked catalog card (TZ W-02).
  subjects.push({
    id: 'subj-chem',
    slug: 'chem',
    title: { ky: 'Химия', ru: 'Химия', en: 'Chemistry' },
    icon: 'flask',
    hue: 265,
    group: 'natural',
    status: 'coming',
  });
  return { groups: GROUPS, subjects };
}

export function getPackage(subjectId: string): ContentPackage | undefined {
  return PACKAGES[subjectId];
}

/** Find a package by subject slug (the client routes by slug, TZ W-05). */
export function getPackageBySlug(slug: string): ContentPackage | undefined {
  return Object.values(PACKAGES).find((p) => p.subject.slug === slug);
}
