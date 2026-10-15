import { describe, it, expect } from 'vitest';
import {
  parseContentPackage,
  ContentPackageSchema,
  TopicSchema,
  SubjectSchema,
  LocalizedSchema,
} from './schema.js';
import { animalCellPackage } from './fixtures/animal-cell.js';

describe('Stage-0 acceptance: sample topics pass schema validation (TZ §11)', () => {
  it('validates the biology animal-cell package', () => {
    const res = ContentPackageSchema.safeParse(animalCellPackage);
    if (!res.success) console.error(res.error.format());
    expect(res.success).toBe(true);
  });

  it('parseContentPackage returns the typed package', () => {
    const pkg = parseContentPackage(animalCellPackage);
    expect(pkg.subject.slug).toBe('bio');
    expect(pkg.topics).toHaveLength(1);
  });

  it('parseContentPackage throws on invalid input', () => {
    expect(() => parseContentPackage({ version: '1.0.0' })).toThrow();
  });
});

describe('LocalizedSchema (TZ: ky/ru/en, at least one language)', () => {
  it('accepts a value with any single language', () => {
    expect(LocalizedSchema.safeParse({ ru: 'Вода' }).success).toBe(true);
    expect(LocalizedSchema.safeParse({ ky: 'Суу' }).success).toBe(true);
  });

  it('rejects an empty localized object', () => {
    expect(LocalizedSchema.safeParse({}).success).toBe(false);
  });
});

describe('SubjectSchema', () => {
  it('rejects hue outside 0–359 (TZ W-03)', () => {
    expect(SubjectSchema.safeParse({ ...animalCellPackage.subject, hue: 360 }).success).toBe(
      false,
    );
    expect(SubjectSchema.safeParse({ ...animalCellPackage.subject, hue: -1 }).success).toBe(
      false,
    );
    expect(SubjectSchema.safeParse({ ...animalCellPackage.subject, hue: 0 }).success).toBe(
      true,
    );
    expect(SubjectSchema.safeParse({ ...animalCellPackage.subject, hue: 359 }).success).toBe(
      true,
    );
  });

  it('requires a non-empty id, slug and icon', () => {
    expect(SubjectSchema.safeParse({ ...animalCellPackage.subject, slug: '' }).success).toBe(
      false,
    );
  });
});

describe('TopicSchema', () => {
  const base = animalCellPackage.topics[0];

  it('accepts the valid base topic', () => {
    expect(TopicSchema.safeParse(base).success).toBe(true);
  });

  it('rejects an unknown scene plugin', () => {
    const bad = structuredClone(base);
    (bad.scene as { plugin: string }).plugin = 'hologram';
    expect(TopicSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an unknown process engine', () => {
    const bad = structuredClone(base);
    (bad.processes[0] as { engine: string }).engine = 'quantum';
    expect(TopicSchema.safeParse(bad).success).toBe(false);
  });
});

describe('ContentPackageSchema', () => {
  it('rejects a quiz question with fewer than two options (TZ W-45)', () => {
    const bad = structuredClone(animalCellPackage);
    bad.topics[0].quiz![0].options = [bad.topics[0].quiz![0].options[0]];
    expect(ContentPackageSchema.safeParse(bad).success).toBe(false);
  });
});
