/** Translation workspace: list filters, write-back, CSV/XLIFF roundtrip (A-11). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, json, makeTestApp, type TestCtx } from '../../test/helpers.js';
import { makeAdminWorld, type AdminWorld } from '../../test/admin-world.js';
import { parseXliff, toXliff } from '../../domain/xliff.js';

let t: TestCtx;
let w: AdminWorld;
beforeAll(async () => {
  t = await makeTestApp();
  w = await makeAdminWorld(t);
});
afterAll(() => t.close());

const KEY = 'concept/bio.nucleus/title';

describe('admin strings', () => {
  it('lists rows per locale with sourceChanged', async () => {
    const r = json(await t.inject({ method: 'GET', url: `${API}/admin/strings?locale=en&limit=500`, token: w.translator.adminToken }));
    const row = r.items.find((x: { key: string }) => x.key === KEY);
    expect(row).toMatchObject({ locale: 'en', status: 'reviewed', sourceChanged: false });
    const none = json(await t.inject({ method: 'GET', url: `${API}/admin/strings?locale=en&untranslated=true`, token: w.translator.adminToken }));
    expect(none.items).toEqual([]);
  });

  it('PATCH writes the value back into the concept; a ru change marks other locales sourceChanged', async () => {
    const tok = w.translator.adminToken;
    const p = await t.inject({ method: 'PATCH', url: `${API}/admin/strings`, token: tok, payload: { items: [{ key: KEY, locale: 'en', value: 'Nucleus (cell)', status: 'reviewed' }] } });
    expect(p.statusCode, p.body).toBe(200);
    expect((await t.repo.content('concept').get('bio.nucleus'))!.data.title.en).toBe('Nucleus (cell)');
    const ru = await t.inject({ method: 'PATCH', url: `${API}/admin/strings`, token: tok, payload: { items: [{ key: KEY, locale: 'ru', value: 'Клеточное ядро', status: 'reviewed' }] } });
    expect(ru.statusCode).toBe(200);
    const changed = json(await t.inject({ method: 'GET', url: `${API}/admin/strings?locale=ky&sourceChanged=true`, token: tok }));
    expect(changed.items.map((x: { key: string }) => x.key)).toEqual([KEY]);
    const unknown = await t.inject({ method: 'PATCH', url: `${API}/admin/strings`, token: tok, payload: { items: [{ key: 'concept/nope/title', locale: 'en', value: 'x', status: 'draft' }] } });
    expect(unknown.statusCode).toBe(400);
    const other = await t.inject({ method: 'PATCH', url: `${API}/admin/strings`, token: w.authorOther.adminToken, payload: { items: [{ key: KEY, locale: 'en', value: 'x', status: 'draft' }] } });
    expect(other.statusCode).toBe(403);
  });

  it('topic strings go into a new draft version when the latest is published', async () => {
    const p = await t.inject({ method: 'PATCH', url: `${API}/admin/strings`, token: w.translator.adminToken, payload: { items: [{ key: 'topic/animal-cell/title', locale: 'en', value: 'Animal cell!', status: 'draft' }] } });
    expect(p.statusCode, p.body).toBe(200);
    const tp = (await t.repo.getTopicByKey('animal-cell'))!;
    const v = (await t.repo.getTopicVersion(tp.latestVersionId!))!;
    expect(v).toMatchObject({ version: '1.0.1', reviewState: 'draft' });
    expect(v.doc.title.en).toBe('Animal cell!');
    expect(tp.status).toBe('draft');
  });

  it('CSV export → edit → import roundtrip', async () => {
    const tok = w.translator.adminToken;
    const e = await t.inject({ method: 'GET', url: `${API}/admin/strings/export?format=csv&locale=en`, token: tok });
    expect(e.statusCode).toBe(200);
    expect(e.headers['content-type']).toContain('text/csv');
    expect(e.headers['content-disposition']).toContain('bilig-en-');
    expect(e.body.split('\r\n')[0]).toBe('﻿key,source,target');
    const edited = e.body.replace(',Nucleus (cell)', ',"Nucleus, the control centre"');
    const i = await t.inject({ method: 'POST', url: `${API}/admin/strings/import`, token: tok, payload: { format: 'csv', locale: 'en', content: edited, status: 'reviewed' } });
    expect(i.statusCode, i.body).toBe(200);
    expect(json(i)).toMatchObject({ updated: 1, unknownKeys: [], errors: [] });
    expect((await t.repo.content('concept').get('bio.nucleus'))!.data.title.en).toBe('Nucleus, the control centre');
  });

  it('XLIFF export → import roundtrip (and DTDs are refused)', async () => {
    const tok = w.translator.adminToken;
    const e = await t.inject({ method: 'GET', url: `${API}/admin/strings/export?format=xliff&locale=ky&source=ru`, token: tok });
    expect(e.headers['content-type']).toContain('application/xliff+xml');
    const units = parseXliff(e.body);
    const u = units.find((x) => x.id === KEY)!;
    expect(u.source).toBe('Клеточное ядро');
    const xml = toXliff(units.map((x) => (x.id === KEY ? { ...x, target: 'Клетка ядросу <&>' } : x)), 'ru', 'ky');
    const i = await t.inject({ method: 'POST', url: `${API}/admin/strings/import`, token: tok, payload: { format: 'xliff', locale: 'ky', content: xml } });
    expect(json(i)).toMatchObject({ updated: 1 });
    expect((await t.repo.content('concept').get('bio.nucleus'))!.data.title.ky).toBe('Клетка ядросу <&>');
    const after = json(await t.inject({ method: 'GET', url: `${API}/admin/strings?locale=ky&sourceChanged=true`, token: tok }));
    expect(after.items.map((x: { key: string }) => x.key)).not.toContain(KEY);
    const bad = await t.inject({ method: 'POST', url: `${API}/admin/strings/import`, token: tok, payload: { format: 'xliff', locale: 'ky', content: '<!DOCTYPE x [<!ENTITY a "b">]><xliff/>' } });
    expect(bad.statusCode).toBe(400);
  });

  it('XLIFF 2.0 units parse', () => {
    const xml = `<xliff version="2.0"><file id="f"><unit id="a/b/c"><segment><source>Привет</source><target>Салам &amp; бол</target></segment></unit></file></xliff>`;
    expect(parseXliff(xml)).toEqual([{ id: 'a/b/c', source: 'Привет', target: 'Салам & бол' }]);
  });
});
