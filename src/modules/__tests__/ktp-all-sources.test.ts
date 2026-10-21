/**
 * Every source a КТП can be made from — each catalog textbook (each subject of an integrated one) and each shipped
 * library book — in every language and from 1 to 10 hours a week: the plan is created, opens, lists and exports;
 * every response matches the contract (a field the contract refuses is a 500 «response_contract»).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { importContent, loadContentDir, DEFAULT_CONTENT_DIR } from '../../services/seed.js';
import { importBooks, loadBookSeeds } from '../../services/book-seed.js';
import { API, json, makeTestApp, makeUser, type TestCtx } from '../../test/helpers.js';
import { makeAdminWorld, type AdminWorld } from '../../test/admin-world.js';

let t: TestCtx;
let w: AdminWorld;

beforeAll(async () => {
  t = await makeTestApp({ seed: false });
  await importContent(t.repo, t.clock, loadContentDir(), t.deps.config);
  await importBooks(t.deps, loadBookSeeds(DEFAULT_CONTENT_DIR));
  w = await makeAdminWorld(t);
}, 60_000);

/** A teacher per 15 КТП (the upload limit is per teacher and hour). */
function teachers() {
  let n = 0;
  let cur: Promise<{ token: string }> | null = null;
  return () => {
    if (!cur || n++ % 15 === 0) cur = makeUser(t.deps, { role: 'teacher', scopeId: w.school.id });
    return cur;
  };
}

async function check(label: string, payload: Record<string, unknown>, token: string, bad: string[]) {
  const r = await t.inject({ method: 'POST', url: `${API}/ktp/from-textbook`, token, payload });
  if (r.statusCode !== 200) return void bad.push(`${label}: create ${r.statusCode} ${r.body.slice(0, 120)}`);
  const plan = json(r);
  if (!plan.rows.length) bad.push(`${label}: no rows`);
  if (plan.rows.some((x: { section?: { title: string } }) => x.section && !x.section.title.trim())) bad.push(`${label}: untitled section`);
  const g = await t.inject({ method: 'GET', url: `${API}/ktp/${plan.id}`, token });
  if (g.statusCode !== 200) bad.push(`${label}: open ${g.statusCode}`);
  return plan as { id: string; classes: string[]; rows: unknown[] };
}

describe('a КТП from every source', () => {
  it('every catalog textbook (each of its subjects), ky / ru / en, 1–10 hours a week', async () => {
    const { textbooks } = await t.deps.content.ktpSources();
    expect(textbooks.length).toBeGreaterThan(0);
    const next = teachers();
    const bad: string[] = [];
    for (const tb of textbooks) {
      const subjects = [...new Set(tb.chapters.map((c) => c.subjectKey))];
      for (const subjectKey of subjects)
        for (const [lang, hoursPerWeek] of [['ky', 1], ['ru', 2], ['en', 3], ['ky', 5], ['ru', 10]] as const)
          await check(`${tb.key}/${subjectKey} ${lang} ${hoursPerWeek}h`, { textbookKey: tb.key, ...(subjects.length > 1 ? { subjectKey } : {}), lang, hoursPerWeek, classes: ['7а', '7 б'] }, (await next()).token, bad);
    }
    expect(bad).toEqual([]);
  }, 300_000);

  it('every library book, ky / ru / en, 1–10 hours a week and 10–40 weeks; it lists and exports', async () => {
    const seeds = loadBookSeeds(DEFAULT_CONTENT_DIR);
    const next = teachers();
    const bad: string[] = [];
    for (const s of seeds) {
      const runs = [
        { lang: 'ky', hoursPerWeek: 1 },
        { lang: 'ru', hoursPerWeek: 2, weeks: 10 },
        { lang: 'en', hoursPerWeek: 3 },
        { hoursPerWeek: 5, weeks: 40 },
        { hoursPerWeek: 10 },
      ];
      for (const run of runs) {
        const { token } = await next();
        const plan = await check(`${s.title} ${JSON.stringify(run)}`, { bookId: s.id, classes: ['7а'], ...run }, token, bad);
        if (!plan || run.hoursPerWeek !== 2) continue;
        const list = await t.inject({ method: 'GET', url: `${API}/ktp`, token });
        if (list.statusCode !== 200) bad.push(`${s.title}: list ${list.statusCode}`);
        const docx = await t.inject({ method: 'GET', url: `${API}/ktp/${plan.id}/docx`, token });
        if (docx.statusCode !== 200) bad.push(`${s.title}: docx ${docx.statusCode}`);
        const lesson = await t.inject({ method: 'GET', url: `${API}/ktp/${plan.id}/lessons/1/plan?class=${encodeURIComponent(plan.classes[0])}`, token });
        if (lesson.statusCode !== 200) bad.push(`${s.title}: lesson plan ${lesson.statusCode}`);
      }
    }
    expect(bad).toEqual([]);
  }, 300_000);

  it('the library lists books of every subject, each kind and language', async () => {
    const { subjects } = json(await t.inject({ method: 'GET', url: `${API}/catalog` }));
    const { token } = await makeUser(t.deps, { role: 'teacher', scopeId: w.school.id });
    const bad: string[] = [];
    let found = 0;
    for (const { key } of subjects as { key: string }[])
      for (const q of ['', '&kind=textbook', '&kind=teacher_guide', '&lang=ky', '&lang=ru', '&lang=en']) {
        const r = await t.inject({ method: 'GET', url: `${API}/books?grade=7&subjectKey=${key}${q}`, token });
        if (r.statusCode !== 200) bad.push(`${key}${q}: ${r.statusCode}`);
        else if (!q) found += json(r).items.length;
      }
    expect(bad).toEqual([]);
    expect(found).toBe(loadBookSeeds(DEFAULT_CONTENT_DIR).length);
  }, 120_000);
});
