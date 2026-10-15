import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sampleItems } from '@bilig/content-model';
import { animalCellPackage } from '@bilig/content-model/fixtures/animal-cell';
import { newId } from '../../ids.js';
import { API, json, makeSchool, makeSchoolWorld, makeTestApp, makeUser, type TestCtx } from '../../test/helpers.js';

let t: TestCtx;
beforeEach(async () => {
  t = await makeTestApp();
});
afterEach(() => t.close());

describe('catalog', () => {
  it('lists subjects/courses localized with Content-Language', async () => {
    const r = await t.inject({ method: 'GET', url: `${API}/subjects`, headers: { 'accept-language': 'en-US,en;q=0.9' } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-language']).toBe('en');
    expect(json(r).subjects.map((s: { key: string }) => s.key)).toContain('bio');
    const c = await t.inject({ method: 'GET', url: `${API}/subjects/bio/courses` });
    expect(json(c).items[0].key).toBe('bio.g7');
    expect((await t.inject({ method: 'GET', url: `${API}/subjects/nope/courses` })).statusCode).toBe(404);
    const d = json(await t.inject({ method: 'GET', url: `${API}/courses/bio.g7` }));
    expect(d.topics.map((x: { key: string }) => x.key).sort()).toEqual(['animal-cell', 'demo-cell']);
    expect(d.topics.find((x: { key: string }) => x.key === 'demo-cell').demo).toBe(true);
  });

  it('fills empty locales from the ky → ru → en chain', async () => {
    const s = (await t.repo.content('subject').get('bio'))!;
    await t.repo.content('subject').update('bio', { data: { ...s.data, title: { ky: '', ru: 'Биология', en: 'Biology' } }, subjectKey: 'bio', searchText: '' }, null, null);
    t.deps.content.invalidate();
    const r = json(await t.inject({ method: 'GET', url: `${API}/catalog`, headers: { 'accept-language': 'ky' } }));
    expect(r.subjects.find((x: { key: string }) => x.key === 'bio').title.ky).toBe('Биология');
  });

  it('manifest: demo open to guests, licensed topics gated by school licence', async () => {
    const demo = await t.inject({ method: 'GET', url: `${API}/topics/demo-cell/manifest` });
    expect(demo.statusCode, demo.body).toBe(200);
    expect(json(demo).manifest.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(json(demo).packageUrl).toContain(json(demo).manifest.hash);
    expect((await t.inject({ method: 'GET', url: `${API}/topics/animal-cell/manifest` })).statusCode).toBe(401);
    const unlicensed = await makeUser(t.deps, { role: 'teacher', scopeId: (await makeSchool(t.deps)).id });
    expect((await t.inject({ method: 'GET', url: `${API}/topics/animal-cell/manifest`, token: unlicensed.token })).statusCode).toBe(403);
    const w = await makeSchoolWorld(t.deps);
    expect((await t.inject({ method: 'GET', url: `${API}/topics/animal-cell/manifest`, token: w.students[0].token })).statusCode).toBe(200);
    const author = await makeUser(t.deps, { role: 'author', scopeId: 'bio' });
    expect((await t.inject({ method: 'GET', url: `${API}/topics/animal-cell/manifest`, token: author.token })).statusCode).toBe(200);
    expect((await t.inject({ method: 'GET', url: `${API}/topics/nope/manifest` })).statusCode).toBe(404);
    // the package itself is immutable when addressed by hash
    const hash = json(demo).manifest.hash;
    const pkg = await t.inject({ method: 'GET', url: `${API}/packages/demo-cell?v=${hash}` });
    expect(pkg.statusCode).toBe(200);
    expect(pkg.headers['cache-control']).toContain('immutable');
    expect((await t.inject({ method: 'GET', url: `${API}/packages/animal-cell` })).statusCode).toBe(401);
  });

  it('searches topics and concepts in every language, localized titles', async () => {
    const nucleus = animalCellPackage.concepts.find((c) => c.key === 'bio.nucleus')!;
    for (const q of [nucleus.title.ru, nucleus.title.en, nucleus.title.ky]) {
      const r = json(await t.inject({ method: 'GET', url: `${API}/search?q=${encodeURIComponent(q)}&lang=en` }));
      const hit = r.items.find((h: { key: string }) => h.key === 'bio.nucleus');
      expect(hit, q).toBeTruthy();
      expect(hit.title).toBe(nucleus.title.en);
    }
    const topics = json(await t.inject({ method: 'GET', url: `${API}/search?q=${encodeURIComponent(animalCellPackage.topic.title.ru)}&kind=topic` }));
    expect(topics.items.every((h: { kind: string }) => h.kind === 'topic')).toBe(true);
    expect((await t.inject({ method: 'GET', url: `${API}/search?q=` })).statusCode).toBe(400);
  });
});

describe('learning: progress & server-checked attempts', () => {
  const quiz = animalCellPackage.topic.activities.quiz!;
  const items = new Map(animalCellPackage.items.map((i) => [i.key, i]));
  const right = (key: string) => {
    const i = items.get(key)!;
    switch (i.type) {
      case 'single': return { type: 'single', value: i.answer };
      case 'multiple': return { type: 'multiple', value: i.answer };
      case 'match': return { type: 'match', value: Object.fromEntries(i.pairs.map((p) => [p.key, p.key])) };
      case 'find-on-model': return { type: 'find-on-model', value: i.targetConceptKey };
      case 'numeric': return { type: 'numeric', value: i.answer };
    }
  };

  it('progress merges as a union; guests are 401', async () => {
    const w = await makeSchoolWorld(t.deps);
    const tok = w.students[0].token;
    expect((await t.inject({ method: 'GET', url: `${API}/progress/animal-cell` })).statusCode).toBe(401);
    const put = (visited: string[]) => t.inject({ method: 'PUT', url: `${API}/progress/animal-cell`, token: tok, payload: { visitedConcepts: visited, completedActivities: ['tour'], updatedAt: '2026-10-15T08:00:00Z' } });
    await put(['bio.nucleus']);
    const r = json(await put(['bio.mito']));
    expect(r.visitedConcepts.sort()).toEqual(['bio.mito', 'bio.nucleus']);
    expect(json(await t.inject({ method: 'GET', url: `${API}/progress/animal-cell`, token: tok })).completedActivities).toEqual(['tour']);
  });

  it('draws the deterministic sample and checks answers on the server', async () => {
    const w = await makeSchoolWorld(t.deps);
    const tok = w.students[0].token;
    const clientId = newId();
    const a = await t.inject({ method: 'POST', url: `${API}/attempts`, token: tok, payload: { clientId, topicKey: 'animal-cell', topicVersion: '1.0.0', seed: 's1' } });
    expect(a.statusCode, a.body).toBe(200);
    const att = json(a);
    expect(att.itemKeys).toEqual(sampleItems(quiz.itemKeys, quiz.sampleSize, 's1'));
    // same clientId → same attempt (idempotent create)
    expect(json(await t.inject({ method: 'POST', url: `${API}/attempts`, token: tok, payload: { clientId, topicKey: 'animal-cell', topicVersion: '1.0.0', seed: 's1' } })).id).toBe(att.id);

    const [k1, k2] = att.itemKeys as string[];
    const ok = json(await t.inject({ method: 'POST', url: `${API}/attempts/${att.id}/answers`, token: tok, payload: { itemKey: k1, response: right(k1), timeMs: 1000 } }));
    expect(ok).toMatchObject({ itemKey: k1, correct: true, score: 1 });
    expect(ok.explanation).toBeTruthy();
    const wrong = json(await t.inject({ method: 'POST', url: `${API}/attempts/${att.id}/answers`, token: tok, payload: { itemKey: k2, response: { type: 'numeric', value: -999 }, timeMs: 500 } }));
    expect(wrong.correct).toBe(false);
    // first answer wins
    expect(json(await t.inject({ method: 'POST', url: `${API}/attempts/${att.id}/answers`, token: tok, payload: { itemKey: k2, response: right(k2), timeMs: 1 } })).correct).toBe(false);
    const notIn = quiz.itemKeys.find((k) => !att.itemKeys.includes(k));
    if (notIn) expect((await t.inject({ method: 'POST', url: `${API}/attempts/${att.id}/answers`, token: tok, payload: { itemKey: notIn, response: right(notIn), timeMs: 1 } })).statusCode).toBe(400);
    // another user cannot touch the attempt
    expect((await t.inject({ method: 'POST', url: `${API}/attempts/${att.id}/finish`, token: w.students[1].token, payload: {} })).statusCode).toBe(404);
    const fin = json(await t.inject({ method: 'POST', url: `${API}/attempts/${att.id}/finish`, token: tok, payload: {} }));
    expect(fin.correctCount).toBe(1);
    expect(fin.total).toBe(quiz.sampleSize);
    expect(fin.attempt.score).toBeCloseTo(1 / quiz.sampleSize);
    expect((await t.inject({ method: 'POST', url: `${API}/attempts/${att.id}/answers`, token: tok, payload: { itemKey: att.itemKeys[2], response: right(att.itemKeys[2]), timeMs: 1 } })).statusCode).toBe(409);
  });

  it('school admins and superadmins cannot save attempts (matrix)', async () => {
    const w = await makeSchoolWorld(t.deps);
    const su = await makeUser(t.deps, { role: 'superadmin' });
    for (const tok of [w.schoolAdmin.token, su.token]) {
      const r = await t.inject({ method: 'POST', url: `${API}/attempts`, token: tok, payload: { clientId: newId(), topicKey: 'animal-cell', topicVersion: '1.0.0', seed: 'x' } });
      expect(r.statusCode).toBe(403);
    }
    const teacher = await t.inject({ method: 'POST', url: `${API}/attempts`, token: w.teacher.token, payload: { clientId: newId(), topicKey: 'animal-cell', topicVersion: '1.0.0', seed: 'x' } });
    expect(teacher.statusCode).toBe(200);
  });

  it('sync: Idempotency-Key required; resending creates no duplicates', async () => {
    const w = await makeSchoolWorld(t.deps);
    const tok = w.students[0].token;
    const seed = 'offline-1';
    const keys = sampleItems(quiz.itemKeys, quiz.sampleSize, seed);
    const body = {
      attempts: [{ clientId: newId(), topicKey: 'animal-cell', topicVersion: '1.0.0', seed, itemKeys: keys, startedAt: '2026-10-15T07:00:00Z', finishedAt: '2026-10-15T07:05:00Z', answers: keys.map((k) => ({ itemKey: k, response: right(k), timeMs: 100, answeredAt: '2026-10-15T07:01:00Z' })) }],
      progress: [],
      events: [{ id: newId(), verb: 'answered', object: { type: 'item', key: keys[0] }, ts: '2026-10-15T07:01:00Z' }],
    };
    expect((await t.inject({ method: 'POST', url: `${API}/sync`, token: tok, payload: body })).statusCode).toBe(400);
    const key = newId();
    const r1 = await t.inject({ method: 'POST', url: `${API}/sync`, token: tok, payload: body, headers: { 'idempotency-key': key } });
    expect(r1.statusCode, r1.body).toBe(200);
    expect(json(r1).attempts[0]).toMatchObject({ status: 'created', score: 1 });
    const r2 = await t.inject({ method: 'POST', url: `${API}/sync`, token: tok, payload: body, headers: { 'idempotency-key': key } });
    expect(json(r2)).toEqual(json(r1));
    const r3 = await t.inject({ method: 'POST', url: `${API}/sync`, token: tok, payload: body, headers: { 'idempotency-key': newId() } });
    expect(json(r3).attempts[0].status).toBe('duplicate');
    expect(json(r3).events).toEqual({ accepted: 0, duplicates: 1 });
    expect(await t.repo.listAttempts({ userId: w.students[0].user.id })).toHaveLength(1);
    expect((await t.inject({ method: 'POST', url: `${API}/sync`, token: tok, payload: { ...body, events: [] }, headers: { 'idempotency-key': key } })).statusCode).toBe(409);
    // cherry-picked items are rejected
    const bad = { ...body, attempts: [{ ...body.attempts[0], clientId: newId(), itemKeys: keys.slice().reverse() }], events: [] };
    expect(json(await t.inject({ method: 'POST', url: `${API}/sync`, token: tok, payload: bad, headers: { 'idempotency-key': newId() } })).attempts[0].status).toBe('rejected');
  });

  it('events: stored under a pseudonym, deduplicated, guests allowed', async () => {
    const w = await makeSchoolWorld(t.deps);
    const ev = { id: newId(), verb: 'selected', object: { type: 'concept', key: 'bio.nucleus' }, topicKey: 'animal-cell', ts: '2026-10-15T07:00:00Z' };
    expect(json(await t.inject({ method: 'POST', url: `${API}/events`, token: w.students[0].token, payload: { events: [ev] } }))).toEqual({ accepted: 1, duplicates: 0 });
    expect(json(await t.inject({ method: 'POST', url: `${API}/events`, payload: { events: [ev, { ...ev, id: newId() }] } }))).toEqual({ accepted: 1, duplicates: 1 });
    const stored = await t.repo.listEvents({});
    expect(stored.map((e) => e.actor)).toContain('guest');
    expect(stored.some((e) => e.actor === w.students[0].user.id)).toBe(false);
  });
});
