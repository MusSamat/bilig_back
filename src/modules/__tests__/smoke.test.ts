import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, json, makeTestApp, makeUser, PASSWORD, type TestCtx } from '../../test/helpers.js';

let t: TestCtx;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(() => t.close());

describe('smoke', () => {
  it('health, catalog, login', async () => {
    const h = await t.inject({ method: 'GET', url: `${API}/health` });
    expect(h.statusCode).toBe(200);
    expect(h.headers['x-request-id']).toBeTruthy();
    const c = await t.inject({ method: 'GET', url: `${API}/catalog`, headers: { 'accept-language': 'en' } });
    expect(c.statusCode, c.body).toBe(200);
    expect(json(c).topics.map((x: { key: string }) => x.key).sort()).toEqual(['animal-cell', 'demo-cell']);
    await makeUser(t.deps, { role: 'teacher', scopeId: '0192f000-0000-7000-8000-000000000001' }, { email: 'smoke@example.kg', password: PASSWORD });
    const l = await t.inject({ method: 'POST', url: `${API}/auth/login`, payload: { email: 'smoke@example.kg', password: PASSWORD } });
    expect(l.statusCode, l.body).toBe(200);
    const me = await t.inject({ method: 'GET', url: `${API}/me`, token: json(l).accessToken });
    expect(me.statusCode, me.body).toBe(200);
    expect(json(me).permissions).toContain('class.manage');
  });
});
