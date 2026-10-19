/** v0.6.0: the topic's ready-made presentation (GET /topics/:key/deck). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { importContent, loadContentDir, DEFAULT_CONTENT_DIR } from '../../services/seed.js';
import { AssetStore } from '../../services/assets.js';
import { buildTopicDeck } from '../../services/topic-deck.js';
import { API, makeTestApp, makeUser, type TestCtx } from '../../test/helpers.js';

let t: TestCtx;
const real = loadContentDir();
beforeEach(async () => {
  t = await makeTestApp({ seed: false });
  const keep = new Set(['pendulum', 'speed']);
  await importContent(t.repo, t.clock, { base: real.base, packages: real.packages.filter((p) => keep.has(p.topic.key)) }, t.deps.config);
});
afterEach(() => t.close());

/** Text of every slide XML inside a .pptx (zip): enough to check what the deck says. */
function pptxText(buf: Buffer): string {
  let out = '';
  for (let p = 0; p + 30 < buf.length; ) {
    if (buf.readUInt32LE(p) !== 0x04034b50) break;
    const method = buf.readUInt16LE(p + 8);
    const size = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extra = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 30, p + 30 + nameLen);
    const start = p + 30 + nameLen + extra;
    const data = buf.subarray(start, start + size);
    if (/^ppt\/(slides|notesSlides)\/.*\.xml$/.test(name)) out += (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    p = start + size;
  }
  return out;
}

describe('GET /topics/:key/deck', () => {
  it('a demo topic: .pptx for a guest, named after the topic, with slides and answers in the notes', async () => {
    const res = await t.inject({ method: 'GET', url: `${API}/topics/pendulum/deck?lang=ru` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('presentationml.presentation');
    expect(String(res.headers['content-disposition'])).toContain('.pptx');
    const body = res.rawPayload;
    expect(body.subarray(0, 2).toString()).toBe('PK');
    const text = pptxText(body);
    expect(text).toContain('Цель урока');
    expect(text).toContain('Вопросы классу');
    expect(text).toContain('Ответ:');
  });

  it('PDF, and the second request is served from the cache (same bytes)', async () => {
    const a = await t.inject({ method: 'GET', url: `${API}/topics/pendulum/deck?lang=ky&format=pdf` });
    expect(a.statusCode).toBe(200);
    expect(a.headers['content-type']).toContain('application/pdf');
    expect(a.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const b = await t.inject({ method: 'GET', url: `${API}/topics/pendulum/deck?lang=ky&format=pdf` });
    expect(b.rawPayload.equals(a.rawPayload)).toBe(true);
  });

  it('licence gate like the topic itself; unknown topic 404', async () => {
    expect((await t.inject({ method: 'GET', url: `${API}/topics/speed/deck` })).statusCode).toBe(401);
    const admin = await makeUser(t.deps, { role: 'superadmin' });
    expect((await t.inject({ method: 'GET', url: `${API}/topics/speed/deck`, token: admin.token })).statusCode).toBe(200);
    expect((await t.inject({ method: 'GET', url: `${API}/topics/no-such/deck` })).statusCode).toBe(404);
  });

  it('embeds the rendered sample images as PNG and follows the lesson order', async () => {
    const pkg = real.packages.find((p) => p.topic.key === 'pendulum')!;
    const deck = await buildTopicDeck({ pkg, lang: 'en', textbooks: real.base.textbooks ?? [], assets: new AssetStore(join(DEFAULT_CONTENT_DIR, 'assets')) });
    expect(deck.images.size).toBeGreaterThan(0);
    for (const img of deck.images.values()) expect(img.contentType).toBe('image/png');
    const kinds = deck.slides.map((s) => s.id.split('-')[0]);
    expect(kinds[0]).toBe('title');
    expect(kinds[1]).toBe('goals');
    expect(kinds.indexOf('sample')).toBeLessThan(kinds.indexOf('step'));
    expect(kinds.at(-1)).toBe('sources');
    expect(deck.slides.filter((s) => s.id.startsWith('q-')).every((s) => s.notes?.startsWith('Answer:'))).toBe(true);
  });

  it('a textbook topic names its § and pages on the goals slide', async () => {
    const pkg = real.packages.find((p) => p.topic.key === 'speed')!;
    const deck = await buildTopicDeck({ pkg, lang: 'ru', textbooks: real.base.textbooks ?? [], assets: new AssetStore(join(DEFAULT_CONTENT_DIR, 'assets')) });
    const goals = deck.slides.find((s) => s.id === 'goals');
    expect(goals && 'text' in goals ? goals.text : '').toMatch(/§ 8\.1, 176–185/);
  });
});
