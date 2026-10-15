/** Analytics, audit and tutor settings (A-17, A-18, A-19). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, json, makeTestApp, type TestCtx } from '../../test/helpers.js';
import { makeAdminWorld, type AdminWorld } from '../../test/admin-world.js';
import { newId } from '../../ids.js';

let t: TestCtx;
let w: AdminWorld;
beforeAll(async () => {
  t = await makeTestApp();
  w = await makeAdminWorld(t);
});
afterAll(() => t.close());

describe('admin ops', () => {
  it('analytics overview counts attempts, events and hardest items', async () => {
    const st = w.student;
    const at = await t.inject({ method: 'POST', url: `${API}/attempts`, token: st.token, payload: { clientId: newId(), topicKey: 'animal-cell', topicVersion: '1.0.0', seed: 's1' } });
    expect(at.statusCode, at.body).toBe(200);
    const a = json(at);
    await t.inject({ method: 'POST', url: `${API}/attempts/${a.id}/answers`, token: st.token, payload: { itemKey: a.itemKeys[0], response: { type: 'single', value: 'zzz' }, timeMs: 1000 } });
    await t.inject({ method: 'POST', url: `${API}/events`, token: st.token, payload: { events: [{ id: newId(), verb: 'selected', object: { type: 'concept', key: 'bio.nucleus' }, topicKey: 'animal-cell', ts: t.clock.now().toISOString() }] } });
    t.clock.advance(1000);
    const r = await t.inject({ method: 'GET', url: `${API}/admin/analytics/overview`, token: w.superadmin.adminToken });
    expect(r.statusCode, r.body).toBe(200);
    const o = json(r);
    expect(o).toMatchObject({ attempts: 1, events: 1, activeStudents: 1, activeSchools: 1 });
    expect(o.bySchool).toEqual([{ key: w.school.id, count: 1 }]);
    expect(o.popularConcepts).toEqual([{ key: 'bio.nucleus', count: 1 }]);
    expect(o.daily).toHaveLength(31);
    expect(o.hardestItems[0]).toMatchObject({ itemKey: a.itemKeys[0], correctRate: 0 });
    expect((await t.inject({ method: 'GET', url: `${API}/admin/analytics/overview`, token: w.schoolAdmin.adminToken })).statusCode).toBe(403);
  });

  it('audit: superadmin sees all; a school admin only entries about their school', async () => {
    await t.deps.audit.log(w.author.user.id, 'content.updated', { type: 'concept', id: 'bio.nucleus' });
    await t.deps.audit.log(w.teacher.user.id, 'class.join_code_reissued', { type: 'class', id: w.cls.id });
    const all = json(await t.inject({ method: 'GET', url: `${API}/admin/audit?limit=100`, token: w.superadmin.adminToken }));
    expect(all.items.length).toBeGreaterThanOrEqual(2);
    const mine = json(await t.inject({ method: 'GET', url: `${API}/admin/audit?limit=100`, token: w.schoolAdmin.adminToken }));
    const actions = mine.items.map((x: { action: string }) => x.action);
    expect(actions).toContain('class.join_code_reissued');
    expect(actions).not.toContain('content.updated');
    const filtered = json(await t.inject({ method: 'GET', url: `${API}/admin/audit?action=content.updated`, token: w.superadmin.adminToken }));
    expect(filtered.items.every((x: { action: string }) => x.action === 'content.updated')).toBe(true);
  });

  it('tutor settings: defaults, If-Match versioned PUT, audit', async () => {
    const g = json(await t.inject({ method: 'GET', url: `${API}/admin/tutor-settings`, token: w.superadmin.adminToken }));
    expect(g).toMatchObject({ enabled: true, provider: 'anthropic', version: 0 });
    const body = { ...g, stopTopics: ['политика'] };
    expect((await t.inject({ method: 'PUT', url: `${API}/admin/tutor-settings`, token: w.superadmin.adminToken, payload: body })).statusCode).toBe(428);
    const p = await t.inject({ method: 'PUT', url: `${API}/admin/tutor-settings`, token: w.superadmin.adminToken, headers: { 'if-match': '0' }, payload: body });
    expect(p.statusCode, p.body).toBe(200);
    expect(json(p)).toMatchObject({ version: 1, stopTopics: ['политика'] });
    const stale = await t.inject({ method: 'PUT', url: `${API}/admin/tutor-settings`, token: w.superadmin.adminToken, headers: { 'if-match': '0' }, payload: body });
    expect(stale.statusCode).toBe(409);
    expect(json(await t.inject({ method: 'GET', url: `${API}/admin/tutor-settings`, token: w.superadmin.adminToken })).version).toBe(1);
    expect((await t.repo.listAudit({ action: 'tutor.settings_changed' }, { limit: 5 })).items).toHaveLength(1);
  });

  it('assets: upload metadata → stub processing report', async () => {
    const u = await t.inject({
      method: 'POST',
      url: `${API}/admin/assets/uploads`,
      token: w.author.adminToken,
      payload: { filename: 'Animal Cell.glb', kind: 'glb', size: 40_000_000, contentType: 'model/gltf-binary', license: 'CC-BY-4.0', author: 'Bilig', source: 'own' },
    });
    expect(u.statusCode, u.body).toBe(200);
    expect(json(u)).toMatchObject({ partSize: 16 * 1024 * 1024, partUrls: [] });
    const id = json(u).assetId;
    expect(json(await t.inject({ method: 'GET', url: `${API}/admin/assets/${id}`, token: w.author.adminToken }))).toMatchObject({ status: 'uploaded', sizeBefore: 40_000_000 });
    const p = json(await t.inject({ method: 'POST', url: `${API}/admin/assets/${id}/process`, token: w.author.adminToken, payload: {} }));
    expect(p).toMatchObject({ status: 'ready', sizeAfter: 40_000_000, nodes: [] });
    expect(p.violations[0]).toMatch(/budget/);
    expect(json(await t.inject({ method: 'GET', url: `${API}/admin/assets`, token: w.author.adminToken })).items).toHaveLength(1);
    expect(p.id).toBe(id);
    expect(json(u).assetId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
