/** Route + authorization tests for bilig_back (driven via fastify inject). */
import { beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from './server.js';
import { devToken } from './principal.js';

// Ensure the tutor has no key so it exercises the 503 offline-fallback path.
beforeAll(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe('bilig_back routes', () => {
  it('health returns ok', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  it('catalog is visible to guests and includes subjects + groups', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/catalog' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups.length).toBeGreaterThan(0);
    expect(body.subjects.some((s: { slug: string }) => s.slug === 'bio')).toBe(true);
  });

  it('returns a content package by subject slug', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/packages/bio' });
    expect(res.statusCode).toBe(200);
    expect(res.json().topics[0].slug).toBe('animal-cell');
  });

  it('404s for an unknown subject slug', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/packages/nope' });
    expect(res.statusCode).toBe(404);
  });

  it('rejects an invalid tutor body with 400', async () => {
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/tutor',
      payload: { question: '', lang: 'xx' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('503s on tutor when the LLM is unavailable (offline fallback contract)', async () => {
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/tutor',
      payload: { question: 'Что такое ядро?', lang: 'ru' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('tutor_unavailable');
  });

  it('authorizes via the principal token (teacher can still read catalog)', async () => {
    const app = buildServer();
    const token = devToken({
      userId: 'u1',
      grants: [{ role: 'teacher', scope: 'school', scopeId: 'school-1' }],
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/catalog',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
