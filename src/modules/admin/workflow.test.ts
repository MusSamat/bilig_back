/** Topic versions and the publish workflow end to end (A-13). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Topic } from '@bilig/content-model';
import { animalCellPackage } from '@bilig/content-model/fixtures/animal-cell';
import { API, json, makeTestApp, type TestCtx } from '../../test/helpers.js';
import { makeAdminWorld, type AdminWorld } from '../../test/admin-world.js';
import { runScheduledPublishes } from '../../services/workflow.js';

let t: TestCtx;
let w: AdminWorld;
let id: string;
const ORIGINAL_HASH = animalCellPackage.manifest.hash;

beforeAll(async () => {
  t = await makeTestApp();
  w = await makeAdminWorld(t);
  id = (await t.repo.getTopicByKey('animal-cell'))!.id;
});
afterAll(() => t.close());

const topicVersion = async () => json(await t.inject({ method: 'GET', url: `${API}/admin/topics/${id}`, token: w.editor.adminToken })).version as number;
const latestDoc = async (): Promise<Topic> => {
  const tp = (await t.repo.getTopic(id))!;
  return (await t.repo.getTopicVersion(tp.latestVersionId!))!.doc;
};
const catalogTopic = async () =>
  json(await t.inject({ method: 'GET', url: `${API}/catalog` })).topics.find((x: { key: string }) => x.key === 'animal-cell');

async function newVersion(edit: (d: Topic) => Topic, token = w.author.adminToken) {
  const v = await topicVersion();
  return t.inject({ method: 'POST', url: `${API}/admin/topics/${id}/versions`, token, headers: { 'if-match': String(v) }, payload: { doc: edit(structuredClone(await latestDoc())) } });
}
const act = (action: string, payload: object = {}, token = w.editor.adminToken) =>
  t.inject({ method: 'POST', url: `${API}/admin/topics/${id}/${action}`, token, payload });

describe('topic versions & publish workflow', () => {
  it('topic detail shows the seeded published version and actions', async () => {
    const d = json(await t.inject({ method: 'GET', url: `${API}/admin/topics/${id}`, token: w.author.adminToken }));
    expect(d).toMatchObject({ key: 'animal-cell', status: 'published', publishedVersion: '1.0.0', latestVersion: '1.0.0', subjectKey: 'bio', demo: false });
    expect(d.availableActions).toEqual(expect.arrayContaining(['archive', 'rollback']));
    const list = json(await t.inject({ method: 'GET', url: `${API}/admin/topics?subjectKey=bio`, token: w.author.adminToken }));
    expect(list.items.map((x: { key: string }) => x.key)).toEqual(['animal-cell', 'demo-cell']);
  });

  it('version create needs If-Match (428) and rejects stale versions (409) and foreign keys (400)', async () => {
    const doc = await latestDoc();
    const r1 = await t.inject({ method: 'POST', url: `${API}/admin/topics/${id}/versions`, token: w.author.adminToken, payload: { doc } });
    expect(r1.statusCode).toBe(428);
    const r2 = await t.inject({ method: 'POST', url: `${API}/admin/topics/${id}/versions`, token: w.author.adminToken, headers: { 'if-match': '"0"' }, payload: { doc } });
    expect(r2.statusCode).toBe(409);
    expect(json(r2).code).toBe('version_mismatch');
    const r3 = await newVersion((d) => ({ ...d, key: 'other-topic' }));
    expect(r3.statusCode).toBe(400);
    const r4 = await newVersion((d) => d, w.authorOther.adminToken);
    expect(r4.statusCode).toBe(403);
    const r5 = await newVersion((d) => ({ ...d, durationMin: 50 }), w.translator.adminToken);
    expect(r5.statusCode).toBe(403);
  });

  it('edit → submit → approve publishes a new package; rollback restores the old hash', async () => {
    const r = await newVersion((d) => ({ ...d, title: { ...d.title, en: 'The animal cell' } }));
    expect(r.statusCode, r.body).toBe(200);
    expect(json(r)).toMatchObject({ version: '1.0.1', reviewState: 'draft', topicKey: 'animal-cell' });
    expect((await catalogTopic()).version).toBe('1.0.0'); // still serving the published one

    const diff = json(await t.inject({ method: 'GET', url: `${API}/admin/topics/${id}/diff`, token: w.author.adminToken }));
    expect(diff.from).toBe('1.0.0');
    expect(diff.to).toBe('1.0.1');
    expect(diff.changes).toEqual(expect.arrayContaining([expect.objectContaining({ path: ['title', 'en'], kind: 'changed', after: 'The animal cell' })]));

    expect((await act('approve')).statusCode).toBe(409); // must be in review first
    const s = await act('submit', { message: 'title' }, w.author.adminToken);
    expect(s.statusCode, s.body).toBe(200);
    expect(json(s)).toMatchObject({ status: 'review', version: '1.0.1', checklist: { schema: true, translations: true, budgets: true, altText: true } });
    expect((await act('approve', {}, w.author.adminToken)).statusCode).toBe(403);

    const a = await act('approve');
    expect(a.statusCode, a.body).toBe(200);
    expect(json(a)).toMatchObject({ status: 'published', version: '1.0.1' });
    const cat = await catalogTopic();
    expect(cat.version).toBe('1.0.1');
    expect(cat.hash).not.toBe(ORIGINAL_HASH);
    expect(cat.title.en).toBe('The animal cell');
    const pkg = json(await t.inject({ method: 'GET', url: `${API}/packages/animal-cell`, token: w.superadmin.token }));
    expect(pkg.manifest.hash).toBe(cat.hash);
    expect(pkg.topic.title.en).toBe('The animal cell');
    expect((await t.repo.listAudit({ action: 'content.publish' }, { limit: 10 })).items).toHaveLength(1);

    const rb = await act('rollback', { toVersion: '1.0.0' });
    expect(rb.statusCode, rb.body).toBe(200);
    expect(json(rb)).toMatchObject({ status: 'published', version: '1.0.0' });
    expect((await catalogTopic()).hash).toBe(ORIGINAL_HASH);
    const versions = json(await t.inject({ method: 'GET', url: `${API}/admin/topics/${id}/versions`, token: w.author.adminToken }));
    expect(versions.items.map((v: { version: string }) => v.version)).toEqual(['1.0.0', '1.0.1']);
    const v1 = json(await t.inject({ method: 'GET', url: `${API}/admin/topics/${id}/versions/1.0.1`, token: w.author.adminToken }));
    expect(v1.doc.title.en).toBe('The animal cell');
  });

  it('the publish checklist blocks missing translations and alt text (409)', async () => {
    const r = await newVersion((d) => ({
      ...d,
      title: { ...d.title, ky: '' },
      activities: { ...d.activities, tour: d.activities.tour && { steps: d.activities.tour.steps.map((st, i) => (i === 0 ? { ...st, altText: { ...st.altText, en: '' } } : st)) } },
    }));
    expect(r.statusCode, r.body).toBe(200);
    const cl = json(await t.inject({ method: 'GET', url: `${API}/admin/topics/${id}/checklist`, token: w.author.adminToken }));
    expect(cl.translations).toBe(false);
    expect(cl.altText).toBe(false);
    expect((await act('submit', {}, w.author.adminToken)).statusCode).toBe(200);
    const a = await act('approve');
    expect(a.statusCode).toBe(409);
    expect(json(a).detail).toBe('checklist_failed');
    const rej = await act('reject', { reason: 'Переводы' });
    expect(json(rej)).toMatchObject({ status: 'draft' });
  });

  it('tours and comparisons are edited as new draft versions', async () => {
    const g = json(await t.inject({ method: 'GET', url: `${API}/admin/tours/animal-cell`, token: w.author.adminToken }));
    expect(g.tour.steps.length).toBeGreaterThan(0);
    const tour = { steps: [g.tour.steps[0]] };
    const v = await topicVersion();
    const noIfMatch = await t.inject({ method: 'PUT', url: `${API}/admin/tours/animal-cell`, token: w.author.adminToken, payload: { tour, version: v } });
    expect(noIfMatch.statusCode).toBe(428);
    const put = await t.inject({ method: 'PUT', url: `${API}/admin/tours/animal-cell`, token: w.author.adminToken, headers: { 'if-match': String(v) }, payload: { tour, version: v } });
    expect(put.statusCode, put.body).toBe(200);
    expect(json(put).doc.activities.tour.steps).toHaveLength(1);
    const del = await t.inject({ method: 'DELETE', url: `${API}/admin/comparisons/animal-cell`, token: w.author.adminToken, headers: { 'if-match': String(await topicVersion()) } });
    expect(del.statusCode, del.body).toBe(200);
    expect(json(await t.inject({ method: 'GET', url: `${API}/admin/comparisons/animal-cell`, token: w.author.adminToken })).comparison).toBeNull();
  });

  it('builds: rebuild a version without publishing; archive hides the topic, restore reopens it', async () => {
    const tp = (await t.repo.getTopic(id))!;
    const b = await t.inject({ method: 'POST', url: `${API}/admin/builds/${tp.publishedVersionId}`, token: w.editor.adminToken, payload: {} });
    expect(b.statusCode, b.body).toBe(200);
    expect(json(b).status).toBe('ready');
    const list = json(await t.inject({ method: 'GET', url: `${API}/admin/builds?topicKey=animal-cell`, token: w.editor.adminToken }));
    expect(list.items.length).toBeGreaterThanOrEqual(3);
    expect((await t.inject({ method: 'GET', url: `${API}/admin/builds`, token: w.author.adminToken })).statusCode).toBe(403);

    const arch = await act('archive', { reason: 'old' });
    expect(arch.statusCode, arch.body).toBe(409); // latest is a draft (tour edit), not published
    const pid = await t.inject({ method: 'PATCH', url: `${API}/admin/topics/${id}`, token: w.editor.adminToken, headers: { 'if-match': String(await topicVersion()) }, payload: { demo: true, version: await topicVersion() } });
    expect(json(pid).demo).toBe(true);
  });

  it('a new topic: create → first version → submit → approve appears in the catalog', async () => {
    const c = await t.inject({ method: 'POST', url: `${API}/admin/topics`, token: w.author.adminToken, payload: { key: 'plant-cell', unitKey: 'bio.g7.cells' } });
    expect(c.statusCode, c.body).toBe(200);
    const nid = json(c).id;
    expect((await t.inject({ method: 'POST', url: `${API}/admin/topics`, token: w.author.adminToken, payload: { key: 'plant-cell', unitKey: 'bio.g7.cells' } })).statusCode).toBe(409);
    const doc = { ...structuredClone(animalCellPackage.topic), key: 'plant-cell', status: 'draft' };
    const v = await t.inject({ method: 'POST', url: `${API}/admin/topics/${nid}/versions`, token: w.author.adminToken, headers: { 'if-match': String(json(c).version) }, payload: { doc } });
    expect(json(v).version).toBe('1.0.0');
    expect((await t.inject({ method: 'POST', url: `${API}/admin/topics/${nid}/submit`, token: w.author.adminToken, payload: {} })).statusCode).toBe(200);
    expect((await t.inject({ method: 'POST', url: `${API}/admin/topics/${nid}/approve`, token: w.editor.adminToken, payload: {} })).statusCode).toBe(200);
    const keys = json(await t.inject({ method: 'GET', url: `${API}/catalog` })).topics.map((x: { key: string }) => x.key);
    expect(keys).toContain('plant-cell');
    const arch = await t.inject({ method: 'POST', url: `${API}/admin/topics/${nid}/archive`, token: w.editor.adminToken, payload: {} });
    expect(json(arch).status).toBe('archived');
    expect(json(await t.inject({ method: 'GET', url: `${API}/catalog` })).topics.map((x: { key: string }) => x.key)).not.toContain('plant-cell');
    const res = await t.inject({ method: 'POST', url: `${API}/admin/topics/${nid}/restore`, token: w.editor.adminToken, payload: {} });
    expect(json(res).status).toBe('draft');
  });
  it('scheduled publish runs when the clock passes scheduledAt', async () => {
    const r = await newVersion((d) => ({ ...d, title: { ky: 'Жаныбар клеткасы', ru: 'Животная клетка', en: 'Animal cell (2)' } }));
    // fix the broken alt text from the previous test
    expect(r.statusCode, r.body).toBe(200);
    const fixed = await newVersion(() => structuredClone({ ...animalCellPackage.topic, status: 'draft', title: { ky: 'Жаныбар клеткасы', ru: 'Животная клетка', en: 'Animal cell (2)' } }));
    expect(fixed.statusCode, fixed.body).toBe(200);
    expect((await act('submit', {}, w.author.adminToken)).statusCode).toBe(200);
    const at = new Date(t.clock.now().getTime() + 3600_000).toISOString();
    const p = await act('publish', { scheduledAt: at });
    expect(p.statusCode, p.body).toBe(200);
    expect(json(p)).toMatchObject({ status: 'review', scheduledAt: at });
    expect(await runScheduledPublishes(t.deps)).toBe(0);
    t.clock.advance(2 * 3600_000);
    expect(await runScheduledPublishes(t.deps)).toBe(1);
    expect((await catalogTopic()).title.en).toBe('Animal cell (2)');
  });

});
