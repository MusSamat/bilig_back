/** Contract v0.3.0 additions (all additive over 0.2.1). */
import { describe, expect, it } from 'vitest';
import {
  ENGINE_PARAMS,
  TopicSchema,
  contentLangFor,
  isLocalizedValue,
  isUiLangCode,
  stepTargetKey,
  stepTargets,
  summarizeTopic,
  validatePackage,
} from './index.js';
import {
  ADMIN_SORT_FIELD_RE,
  AdminConceptPatchSchema,
  AdminListQuerySchema,
  AuditQuerySchema,
  ENDPOINTS,
  LicensePatchSchema,
  LocalesParamSchema,
  ProblemSchema,
  ReviewCommentPatchSchema,
  SchoolPatchSchema,
  StringsPatchRequestSchema,
  UserGrantsPutSchema,
  problem,
} from './api/index.js';
import { animalCellPackage } from './fixtures/animal-cell.js';

describe('v0.3.0 languages', () => {
  it('UI language codes map to a content language', () => {
    expect(isUiLangCode('uz')).toBe(true);
    expect(isUiLangCode('ru-KG')).toBe(true);
    expect(isUiLangCode('Russian')).toBe(false);
    expect(contentLangFor('ru')).toBe('ru');
    expect(contentLangFor('ru-KG')).toBe('ru');
    expect(contentLangFor('uz')).toBe('ky');
    expect(contentLangFor('uz', 'ru')).toBe('ru');
  });

  it('isLocalizedValue needs every active language and only language keys', () => {
    expect(isLocalizedValue({ ky: 'а', ru: 'б', en: 'c' })).toBe(true);
    expect(isLocalizedValue({ ky: 'а', ru: 'б' })).toBe(false);
    expect(isLocalizedValue({ ky: 'а', ru: 'б', en: 'c', note: 'x' })).toBe(false);
    expect(isLocalizedValue(['ky'])).toBe(false);
  });
});

describe('v0.3.0 content model', () => {
  it('topic props and rights are optional and validated', () => {
    const topic = { ...animalCellPackage.topic, props: [{ kind: 'formula', type: 'formula', value: 'H_2O' }], rights: [{ license: 'CC-BY-4.0', author: 'A', source: 'https://x', covers: 'models/cell.glb' }] };
    expect(TopicSchema.safeParse(topic).success).toBe(true);
    expect(TopicSchema.safeParse({ ...topic, rights: [{ license: '', author: 'A', source: 'x' }] }).success).toBe(false);
    const bad = validatePackage({ ...animalCellPackage, topic: { ...topic, props: [{ kind: 'text', type: 'nope', value: { ky: 'a', ru: 'a', en: 'a' } }] } });
    expect(bad.issues.some((i) => i.code === 'property_type_unknown' && i.path.join('.') === 'topic.props.0.type')).toBe(true);
    const mismatch = validatePackage({ ...animalCellPackage, topic: { ...topic, props: [{ kind: 'text', type: 'molarMass', value: { ky: 'a', ru: 'a', en: 'a' } }] } });
    expect(mismatch.issues.some((i) => i.code === 'property_kind_mismatch')).toBe(true);
  });

  it('summarizeTopic carries conceptKeys', () => {
    expect(summarizeTopic(animalCellPackage).conceptKeys).toEqual(animalCellPackage.topic.conceptKeys);
  });

  it('engine parameter conventions and per-step targets', () => {
    expect(Object.keys(ENGINE_PARAMS).sort()).toEqual(['ode', 'stoich', 'timeline']);
    expect(stepTargetKey('atp', 'glycolysis')).toBe('atp@glycolysis');
    const steps = [{ key: 'a' }, { key: 'b' }, { key: 'c' }] as never;
    expect(stepTargets({ steps, params: { 'atp@a': 2, 'atp@c': 36, other: 1 } }, 'atp')).toEqual([
      { stepKey: 'a', value: 2 },
      { stepKey: 'c', value: 36 },
    ]);
  });
});

describe('v0.3.0 API', () => {
  it('patch schemas accept null on optional fields only', () => {
    expect(AdminConceptPatchSchema.safeParse({ subtitle: null, funFact: null, version: 1 }).success).toBe(true);
    expect(AdminConceptPatchSchema.safeParse({ title: null, version: 1 }).success).toBe(false);
    expect(AdminConceptPatchSchema.safeParse({ hue: 10 }).success).toBe(false);
  });

  it('list queries: sort/order and new filters', () => {
    expect(AdminListQuerySchema.parse({ sort: 'updatedAt', order: 'desc', mine: 'true', unitKey: 'bio.g7.u1' })).toMatchObject({ sort: 'updatedAt', order: 'desc', mine: true });
    expect(AdminListQuerySchema.safeParse({ order: 'up' }).success).toBe(false);
    expect(ADMIN_SORT_FIELD_RE.test('title')).toBe(true);
    expect(ADMIN_SORT_FIELD_RE.test('data.key')).toBe(false);
    expect(AuditQuerySchema.safeParse({ actorId: '01929f3c' }).success).toBe(true);
    expect(AuditQuerySchema.safeParse({ actorId: 'zz' }).success).toBe(false);
    expect(LocalesParamSchema.safeParse('ru,ky,en').success).toBe(true);
    expect(LocalesParamSchema.safeParse('ru,de').success).toBe(false);
  });

  it('strings PATCH items take optional preconditions; schools/licences an optional version', () => {
    expect(StringsPatchRequestSchema.safeParse({ items: [{ key: 'k', locale: 'ky', value: 'v', status: 'draft', version: 2, sourceHash: 'abc' }] }).success).toBe(true);
    expect(SchoolPatchSchema.safeParse({ name: 'x' }).success).toBe(true);
    expect(SchoolPatchSchema.safeParse({ name: 'x', version: 2 }).success).toBe(true);
    expect(LicensePatchSchema.safeParse({ seats: 3, version: 1 }).success).toBe(true);
    expect(ReviewCommentPatchSchema.safeParse({}).success).toBe(false);
    expect(UserGrantsPutSchema.safeParse({ grants: [] }).success).toBe(true);
  });

  it('the enrolment token travels in the problem body', () => {
    const p = problem('forbidden', { detail: 'totp_enrollment_required', enrollmentToken: 'x'.repeat(40) });
    expect(ProblemSchema.parse(p).enrollmentToken).toHaveLength(40);
  });

  it('optional If-Match endpoints and the new routes are declared', () => {
    expect(ENDPOINTS.adminSchoolPatch).toMatchObject({ ifMatchOptional: true });
    expect('ifMatch' in ENDPOINTS.adminSchoolPatch).toBe(false);
    for (const n of ['adminReviewCommentList', 'adminAssetComplete', 'adminTopicScheduleCancel', 'authTotpEnrollVerify', 'adminUserReveal', 'adminTutorRegression', 'adminStringRows'] as const) {
      expect(ENDPOINTS[n].path.startsWith('/')).toBe(true);
    }
  });
});
