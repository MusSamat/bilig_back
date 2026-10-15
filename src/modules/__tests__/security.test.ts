import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../ids.js';
import { API, json, makeSchoolWorld, makeTestApp, makeUser, type TestCtx } from '../../test/helpers.js';

let t: TestCtx;
beforeAll(async () => {
  t = await makeTestApp({ config: { corsOrigins: ['https://bilig.kg'] } });
});
afterAll(() => t.close());

describe('HTTP hardening', () => {
  it('sets a CSP without unsafe-inline and other helmet headers', async () => {
    const r = await t.inject({ method: 'GET', url: `${API}/health` });
    const csp = String(r.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
  });

  it('CORS: allows the client origin with credentials, not others', async () => {
    const ok = await t.inject({ method: 'OPTIONS', url: `${API}/catalog`, headers: { origin: 'https://bilig.kg', 'access-control-request-method': 'GET' } });
    expect(ok.headers['access-control-allow-origin']).toBe('https://bilig.kg');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const bad = await t.inject({ method: 'OPTIONS', url: `${API}/catalog`, headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('problem+json for 404, validation errors, oversized bodies and bad JSON', async () => {
    const nf = await t.inject({ method: 'GET', url: `${API}/nope` });
    expect(nf.statusCode).toBe(404);
    expect(nf.headers['content-type']).toContain('application/problem+json');
    const v = await t.inject({ method: 'POST', url: `${API}/auth/login`, payload: { email: 'not-an-email', password: '' } });
    expect(v.statusCode).toBe(400);
    expect(json(v).issues.length).toBeGreaterThan(0);
    const big = await t.inject({ method: 'POST', url: `${API}/auth/login`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ email: 'a@b.kg', password: 'x'.repeat(2 * 1024 * 1024) }) });
    expect(big.statusCode).toBe(413);
    expect(json(big).code).toBe('payload_too_large');
    const bad = await t.inject({ method: 'POST', url: `${API}/auth/login`, headers: { 'content-type': 'application/json' }, payload: '{nope' });
    expect(bad.statusCode).toBe(400);
  });

  it('echoes a trace id (X-Request-Id or traceparent)', async () => {
    const a = await t.inject({ method: 'GET', url: `${API}/health`, headers: { 'x-request-id': 'trace-abc-123' } });
    expect(a.headers['x-request-id']).toBe('trace-abc-123');
    const b = await t.inject({ method: 'GET', url: `${API}/health`, headers: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' } });
    expect(b.headers['x-request-id']).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('/ready and /version', async () => {
    expect(json(await t.inject({ method: 'GET', url: `${API}/ready` }))).toMatchObject({ status: 'ok', checks: { database: 'ok' } });
    expect(json(await t.inject({ method: 'GET', url: `${API}/version` })).contract).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('RBAC matrix at the route level (TZ §2)', () => {
  it('enforces the matrix for every role on representative endpoints', async () => {
    const w = await makeSchoolWorld(t.deps);
    const su = await makeUser(t.deps, { role: 'superadmin' });
    const author = await makeUser(t.deps, { role: 'author', scopeId: 'bio' });
    const editor = await makeUser(t.deps, { role: 'editor', scopeId: 'bio' });
    const roles: Record<string, string | undefined> = {
      guest: undefined,
      student: w.students[0].token,
      teacher: w.teacher.token,
      school_admin: w.schoolAdmin.token,
      author: author.token,
      editor: editor.token,
      superadmin: su.token,
    };
    const attempt = () => ({ clientId: newId(), topicKey: 'animal-cell', topicVersion: '1.0.0', seed: 's' });
    const cases: { name: string; req: () => { method: 'GET' | 'POST'; url: string; payload?: Record<string, unknown> }; allowed: string[] }[] = [
      { name: 'demo topic (demo.view)', req: () => ({ method: 'GET', url: `${API}/topics/demo-cell/manifest` }), allowed: Object.keys(roles) },
      { name: 'licensed topic (topic.view)', req: () => ({ method: 'GET', url: `${API}/topics/animal-cell/manifest` }), allowed: ['student', 'teacher', 'school_admin', 'author', 'editor', 'superadmin'] },
      { name: 'save quiz attempts', req: () => ({ method: 'POST', url: `${API}/attempts`, payload: attempt() }), allowed: ['student', 'teacher'] },
      { name: 'class management (own school)', req: () => ({ method: 'GET', url: `${API}/classes/${w.cls.id}` }), allowed: ['teacher', 'school_admin', 'superadmin'] },
      { name: 'assignments of the class', req: () => ({ method: 'GET', url: `${API}/classes/${w.cls.id}/assignments` }), allowed: ['teacher', 'school_admin', 'superadmin'] },
    ];
    for (const c of cases) {
      for (const [role, token] of Object.entries(roles)) {
        const res = await t.inject({ ...c.req(), token });
        const ok = res.statusCode < 400;
        expect(ok, `${c.name} as ${role}: ${res.statusCode} ${res.body.slice(0, 120)}`).toBe(c.allowed.includes(role));
        if (!ok) expect([401, 403]).toContain(res.statusCode);
      }
    }
  });
});
