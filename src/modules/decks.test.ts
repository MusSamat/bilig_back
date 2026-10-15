/** Decks: presentations CRUD + If-Match, ownership, LLM mode, export, snapshots. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, json, makeSchoolWorld, makeTestApp, makeUser, type MadeUser, type TestCtx } from '../test/helpers.js';
import { MockProvider } from '../services/tutor-provider.js';
import { decodeImageDataUri, sniffImage } from './decks.js';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const PNG = `data:image/png;base64,${PNG_B64}`;
const scene = (topicKey = 'demo-cell') => ({ lang: 'ru', subjectKey: 'bio', topicKey });

let t: TestCtx;
let teacher: MadeUser;
let other: MadeUser;

beforeAll(async () => {
  t = await makeTestApp();
  teacher = (await makeSchoolWorld(t.deps)).teacher;
  other = await makeUser(t.deps, { role: 'teacher', scopeId: '0192f000-0000-7000-8000-0000000000aa' });
});
afterAll(() => t.close());

const create = (token: string, payload: Record<string, unknown>) =>
  t.inject({ method: 'POST', url: `${API}/presentations`, token, payload: { topicKey: 'animal-cell', title: 'Клетка', lang: 'ru', ...payload } });

describe('presentations', () => {
  it('creates a deterministic template deck from the published package', async () => {
    const res = await create(teacher.token, {});
    expect(res.statusCode, res.body).toBe(200);
    const p = json(res);
    expect(p.version).toBe(1);
    expect(p.slides[0].kind).toBe('title');
    expect(p.slides.some((s: { kind: string }) => s.kind === 'concept')).toBe(true);
    expect(p.slides.some((s: { kind: string }) => s.kind === 'process')).toBe(true);
    const again = json(await create(teacher.token, {}));
    expect(again.slides).toEqual(p.slides);
  });

  it('requires a session and a licence for licensed topics', async () => {
    expect((await t.inject({ method: 'POST', url: `${API}/presentations`, payload: { topicKey: 'demo-cell', title: 'x', lang: 'ru' } })).statusCode).toBe(401);
    expect((await create(other.token, {})).statusCode).toBe(403);
    expect((await create(other.token, { topicKey: 'demo-cell' })).statusCode).toBe(200);
    expect((await create(other.token, { topicKey: 'nope' })).statusCode).toBe(404);
  });

  it('get/list/patch/delete are owner-only; If-Match is enforced', async () => {
    const p = json(await create(teacher.token, {}));
    const url = `${API}/presentations/${p.id}`;
    expect((await t.inject({ method: 'GET', url, token: other.token })).statusCode).toBe(404);
    const got = await t.inject({ method: 'GET', url, token: teacher.token });
    expect(got.statusCode).toBe(200);
    expect(got.headers.etag).toBe('"1"');

    const list = json(await t.inject({ method: 'GET', url: `${API}/presentations?limit=100`, token: teacher.token }));
    expect(list.items.some((x: { id: string }) => x.id === p.id)).toBe(true);
    expect(list.items[0].slides).toBeUndefined();
    const otherList = json(await t.inject({ method: 'GET', url: `${API}/presentations`, token: other.token }));
    expect(otherList.items.some((x: { id: string }) => x.id === p.id)).toBe(false);

    const noIfMatch = await t.inject({ method: 'PATCH', url, token: teacher.token, payload: { title: 'Новое', version: 1 } });
    expect(noIfMatch.statusCode).toBe(428);
    expect(json(noIfMatch).code).toBe('precondition_required');

    const slides = [{ id: 's1', kind: 'text', title: 'Үй тапшырма', text: 'Өсүмдүк клеткасы, Ң' }];
    const ok = await t.inject({ method: 'PATCH', url, token: teacher.token, headers: { 'if-match': '"1"' }, payload: { title: 'Новое', slides, version: 1 } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(json(ok)).toMatchObject({ version: 2, title: 'Новое', slides });

    const stale = await t.inject({ method: 'PATCH', url, token: teacher.token, headers: { 'if-match': '1' }, payload: { title: 'X', version: 1 } });
    expect(stale.statusCode).toBe(409);
    expect(json(stale).code).toBe('version_mismatch');
    const mismatch = await t.inject({ method: 'PATCH', url, token: teacher.token, headers: { 'if-match': '2' }, payload: { title: 'X', version: 1 } });
    expect(mismatch.statusCode).toBe(409);
    const foreign = await t.inject({ method: 'PATCH', url, token: other.token, headers: { 'if-match': '2' }, payload: { title: 'X', version: 2 } });
    expect(foreign.statusCode).toBe(404);

    expect((await t.inject({ method: 'DELETE', url, token: other.token })).statusCode).toBe(404);
    expect((await t.inject({ method: 'DELETE', url, token: teacher.token })).statusCode).toBe(200);
    expect((await t.inject({ method: 'GET', url, token: teacher.token })).statusCode).toBe(404);
  });

  it('rejects slides referencing someone else’s snapshot', async () => {
    const snap = json(await t.inject({ method: 'POST', url: `${API}/snapshots`, token: other.token, payload: { topicKey: 'demo-cell', topicVersion: '1.0.0', image: PNG, sceneState: scene() } }));
    const res = await create(teacher.token, { slides: [{ id: 'a', kind: 'snapshot', snapshotId: snap.id }] });
    expect(res.statusCode).toBe(400);
  });
});

describe('llm mode', () => {
  it('uses JSON slides from the provider, built only from package material', async () => {
    const provider = new MockProvider(() => [
      { type: 'text', text: 'Here: [{"id":"t","kind":"title","title":"Клетка"},' },
      { type: 'text', text: '{"id":"c","kind":"concept","conceptKey":"bio.nucleus","title":"Ядро","text":"Башкаруу борбору"}]' },
    ]);
    const ctx = await makeTestApp({ tutor: provider });
    try {
      const u = await makeUser(ctx.deps, { role: 'teacher', scopeId: '0192f000-0000-7000-8000-0000000000bb' });
      const res = await ctx.inject({ method: 'POST', url: `${API}/presentations`, token: u.token, payload: { topicKey: 'demo-cell', title: 'x', lang: 'ky', mode: 'llm' } });
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res).slides.map((s: { id: string }) => s.id)).toEqual(['t', 'c']);
      const req = provider.calls[0];
      expect(req.system).toContain('bio.nucleus');
      expect(req.system).not.toContain(u.user.displayName);
      expect(req.system).not.toContain(u.user.id);
      expect(JSON.stringify(req.messages)).not.toContain(u.user.id);
    } finally {
      await ctx.close();
    }
  });

  it('falls back to the template on garbage, unknown keys, errors or no provider', async () => {
    for (const provider of [
      new MockProvider(() => [{ type: 'text', text: 'not json at all' }]),
      new MockProvider(() => [{ type: 'text', text: '[{"id":"c","kind":"concept","conceptKey":"bio.unknown","title":"x","text":"y"}]' }]),
      new MockProvider(() => new Error('boom')),
      null,
    ]) {
      const ctx = await makeTestApp({ tutor: provider });
      try {
        const u = await makeUser(ctx.deps, { role: 'teacher', scopeId: '0192f000-0000-7000-8000-0000000000cc' });
        const res = await ctx.inject({ method: 'POST', url: `${API}/presentations`, token: u.token, payload: { topicKey: 'demo-cell', title: 'x', lang: 'en', mode: 'llm' } });
        expect(res.statusCode).toBe(200);
        expect(json(res).slides[0]).toMatchObject({ id: 'title', kind: 'title' });
      } finally {
        await ctx.close();
      }
    }
  });
});

describe('export', () => {
  it('exports pptx and pdf into storage, embedding owned snapshots', async () => {
    const snap = json(await t.inject({ method: 'POST', url: `${API}/snapshots`, token: teacher.token, payload: { topicKey: 'animal-cell', topicVersion: '1.0.0', image: PNG, sceneState: scene('animal-cell') } }));
    const p = json(await create(teacher.token, {}));
    const slides = [...p.slides, { id: 'snap', kind: 'snapshot', snapshotId: snap.id, caption: 'Ядро — Өзөк, Ң' }];
    const patched = await t.inject({ method: 'PATCH', url: `${API}/presentations/${p.id}`, token: teacher.token, headers: { 'if-match': '1' }, payload: { slides, version: 1 } });
    expect(patched.statusCode, patched.body).toBe(200);

    for (const [format, magic] of [['pptx', 'PK'], ['pdf', '%PDF']] as const) {
      const res = await t.inject({ method: 'POST', url: `${API}/presentations/${p.id}/export?format=${format}`, token: teacher.token, payload: {} });
      expect(res.statusCode, res.body).toBe(200);
      const body = json(res);
      expect(body.status).toBe('done');
      const key = body.url.split('/files/')[1];
      expect(key).toMatch(new RegExp(`^exports/${teacher.user.id}/.+\\.${format}$`));
      const obj = t.storage.objects.get(key)!;
      expect(obj.body.subarray(0, magic.length).toString('latin1')).toBe(magic);
      const file = await t.inject({ method: 'GET', url: `/files/${key}` });
      expect(file.statusCode).toBe(200);
    }
    expect((await t.inject({ method: 'POST', url: `${API}/presentations/${p.id}/export?format=pptx`, token: other.token, payload: {} })).statusCode).toBe(404);
    expect((await t.inject({ method: 'POST', url: `${API}/presentations/${p.id}/export?format=doc`, token: teacher.token, payload: {} })).statusCode).toBe(400);
  });
});

describe('snapshots', () => {
  it('creates and reads an owned snapshot', async () => {
    const res = await t.inject({ method: 'POST', url: `${API}/snapshots`, token: teacher.token, payload: { topicKey: 'demo-cell', topicVersion: '1.0.0', image: PNG, sceneState: { ...scene(), focus: 'bio.nucleus' } } });
    expect(res.statusCode, res.body).toBe(200);
    const s = json(res);
    expect(s.sceneState.focus).toBe('bio.nucleus');
    expect(t.storage.objects.get(s.imageUrl.split('/files/')[1])!.contentType).toBe('image/png');
    expect((await t.inject({ method: 'GET', url: `${API}/snapshots/${s.id}`, token: teacher.token })).statusCode).toBe(200);
    expect((await t.inject({ method: 'GET', url: `${API}/snapshots/${s.id}`, token: other.token })).statusCode).toBe(404);
  });

  it('validates image bytes, size, topic version and auth', async () => {
    const post = (payload: Record<string, unknown>, token: string | undefined = teacher.token) =>
      t.inject({ method: 'POST', url: `${API}/snapshots`, token, payload: { topicKey: 'demo-cell', topicVersion: '1.0.0', image: PNG, sceneState: scene(), ...payload } });
    expect((await post({ image: `data:image/jpeg;base64,${PNG_B64}` })).statusCode).toBe(400); // png bytes declared as jpeg
    expect((await post({ image: `data:image/png;base64,${Buffer.from('hello world, not an image').toString('base64')}` })).statusCode).toBe(400);
    expect((await post({ topicVersion: '9.9.9' })).statusCode).toBe(404);
    expect((await post({ sceneState: scene('animal-cell') })).statusCode).toBe(400);
    expect((await post({}, '')).statusCode).toBe(401);
    const big = Buffer.alloc(5 * 1024 * 1024 + 100);
    Buffer.from(PNG_B64, 'base64').copy(big);
    const tooBig = await post({ image: `data:image/png;base64,${big.toString('base64')}` });
    expect([400, 413]).toContain(tooBig.statusCode);
    const huge = await post({ image: `data:image/png;base64,${Buffer.alloc(7 * 1024 * 1024).toString('base64')}` });
    expect(huge.statusCode).toBe(413);
  });

  it('sniffs magic bytes', () => {
    expect(sniffImage(Buffer.from(PNG_B64, 'base64'))).toBe('png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))).toBe('webp');
    expect(sniffImage(Buffer.from('GIF89a'))).toBeNull();
    expect(() => decodeImageDataUri('data:text/html;base64,AAAA')).toThrow();
  });
});
