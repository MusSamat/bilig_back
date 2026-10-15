/** Route + authorization tests for bilig_back (driven via fastify inject). */
import { beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CatalogResponseSchema,
  HealthResponseSchema,
  MeResponseSchema,
  ProblemSchema,
  SubjectsResponseSchema,
  TopicManifestResponseSchema,
  routePath,
} from '@bilig/content-model/api';
import { validatePackage, type ContentPackage } from '@bilig/content-model';
import { animalCellPackage } from '@bilig/content-model/fixtures/animal-cell';
import { buildServer } from './server.js';
import { devToken } from './principal.js';
import { loadContentRepo } from './content-repo.js';
import { citationsFor, topicContext } from './tutor.js';

const UUID = '01929f3c-7d2a-7cc1-9a51-2c9f3e7b1a00';

beforeAll(() => {
  delete process.env.ANTHROPIC_API_KEY; // exercise the 503 offline-fallback path
});

describe('content repo', () => {
  it('loads and validates the seed content; catalog lists published topics with counts', () => {
    const repo = loadContentRepo();
    const catalog = CatalogResponseSchema.parse(repo.catalog());
    expect(catalog.subjects.map((s) => s.key)).toEqual(['bio', 'chem']);
    expect(catalog.topics[0]).toMatchObject({ key: 'animal-cell', counts: { models: 2 } });
    expect(validatePackage(repo.getPackage('animal-cell')).ok).toBe(true);
    expect(repo.getManifest('nope')).toBeUndefined();
  });

  it('seed package matches the contract fixture (regenerate content/ when the fixture changes)', () => {
    expect(loadContentRepo().getPackage('animal-cell')).toEqual(animalCellPackage);
  });
});

describe('bilig_back routes', () => {
  const app = buildServer();

  it('health reports the contract version', async () => {
    const res = await app.inject({ method: 'GET', url: routePath('health') });
    expect(res.statusCode).toBe(200);
    expect(HealthResponseSchema.parse(res.json()).contract).toBe('0.2.0');
  });

  it('catalog and subjects are visible to guests', async () => {
    const res = await app.inject({ method: 'GET', url: routePath('catalog') });
    expect(res.statusCode).toBe(200);
    expect(CatalogResponseSchema.safeParse(res.json()).success).toBe(true);
    const subj = await app.inject({ method: 'GET', url: routePath('subjects') });
    expect(SubjectsResponseSchema.parse(subj.json()).groups.length).toBeGreaterThan(0);
  });

  it('serves the topic manifest and package by topic key', async () => {
    const m = await app.inject({ method: 'GET', url: '/api/v1/topics/animal-cell/manifest' });
    expect(m.statusCode).toBe(200);
    const manifest = TopicManifestResponseSchema.parse(m.json());
    const p = await app.inject({ method: 'GET', url: manifest.packageUrl });
    expect(p.statusCode).toBe(200);
    expect(validatePackage(p.json() as ContentPackage).ok).toBe(true);
  });

  it('unknown topic / route → 404 problem+json', async () => {
    for (const url of ['/api/v1/packages/nope', '/api/v1/topics/nope/manifest', '/api/v1/nothing']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(ProblemSchema.parse(res.json()).code).toBe('not_found');
    }
  });

  it('rejects an invalid tutor body with a 400 problem', async () => {
    const res = await app.inject({ method: 'POST', url: routePath('tutorAsk'), payload: { question: '', lang: 'xx' } });
    expect(res.statusCode).toBe(400);
    const body = ProblemSchema.parse(res.json());
    expect(body.code).toBe('validation_failed');
    expect(body.issues?.length).toBeGreaterThan(0);
  });

  it('tutor: unknown topic → 404; LLM unavailable → 503 tutor_unavailable', async () => {
    const missing = await app.inject({
      method: 'POST', url: routePath('tutorAsk'),
      payload: { topicKey: 'nope', question: 'Что такое ядро?', lang: 'ru' },
    });
    expect(missing.statusCode).toBe(404);
    const res = await app.inject({
      method: 'POST', url: routePath('tutorAsk'),
      payload: { topicKey: 'animal-cell', question: 'Что такое ядро?', lang: 'ru' },
    });
    expect(res.statusCode).toBe(503);
    expect(ProblemSchema.parse(res.json()).code).toBe('tutor_unavailable');
  });

  it('/me: 401 for guests; permissions list for signed-in users', async () => {
    const anon = await app.inject({ method: 'GET', url: routePath('me') });
    expect(anon.statusCode).toBe(401);
    const token = devToken({ userId: UUID, grants: [{ role: 'teacher', scope: 'school', scopeId: 'school-1' }] });
    const res = await app.inject({ method: 'GET', url: routePath('me'), headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const me = MeResponseSchema.parse(res.json());
    expect(me.permissions).toContain('class.manage');
    expect(me.permissions).not.toContain('platform.manage');
  });

  it('a teacher can still read the catalog', async () => {
    const token = devToken({ userId: 'u1', grants: [{ role: 'teacher', scope: 'school', scopeId: 'school-1' }] });
    const res = await app.inject({ method: 'GET', url: routePath('catalog'), headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
  });
});

describe('tutor grounding helpers', () => {
  it('builds topic context and finds cited concepts', () => {
    expect(topicContext(animalCellPackage, 'ru')).toContain('[bio.nucleus] Ядро');
    expect(citationsFor('Митохондрия делает АТФ.', animalCellPackage)).toEqual(['bio.mitochondrion']);
    expect(citationsFor('ok', animalCellPackage, 'bio.nucleus')).toEqual(['bio.nucleus']);
    expect(citationsFor('ok', animalCellPackage, 'bio.ghost')).toEqual([]);
  });
});

describe('app code', () => {
  it('does not import @bilig/content-model fixtures', () => {
    const root = fileURLToPath(new URL('.', import.meta.url));
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(f) && !/\.test\.ts$/.test(f) ? [p] : [];
      });
    expect(files(root).filter((f) => /content-model\/(src\/)?fixtures/.test(readFileSync(f, 'utf8')))).toEqual([]);
  });
});
