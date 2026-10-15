/**
 * Admin: analytics (A-17), audit log (A-19), tutor settings (A-18).
 *
 * Analytics are computed on read from the repository lists for [from, to)
 * (default: the last 30 days) — fine for the pilot; a materialised rollup
 * belongs in bilig_worker at scale. Events carry only pseudonyms, so
 * "active students" counts distinct attempt owners.
 *
 * Audit scope for a school admin: entries whose actor or target is a user of
 * their school, or whose target is one of their school's classes / the school.
 */
import type { FastifyInstance } from 'fastify';
import type { TutorSettings } from '@bilig/content-model/api';
import type { Deps } from '../../deps.js';
import { fail } from '../../http/errors.js';
import { pageArray, pageOf } from '../../repo/paging.js';
import type { AnswerRec, AuditRec } from '../../repo/types.js';
import { getTutorSettings, putTutorSettings } from '../../services/tutor-settings.js';
import { adminSchools, isSuperadmin, iso, reg, type AnyCtx } from './util.js';

const DAY = 86400_000;

export function itemStats(answers: readonly AnswerRec[]) {
  const per = new Map<string, AnswerRec[]>();
  for (const a of answers) per.set(a.itemKey, [...(per.get(a.itemKey) ?? []), a]);
  return [...per.entries()].map(([itemKey, list]) => {
    const wrong = new Map<string, number>();
    for (const a of list) {
      if (a.correct) continue;
      const v = a.response.value;
      for (const k of Array.isArray(v) ? v.map(String) : typeof v === 'object' && v ? [] : [String(v)]) wrong.set(k, (wrong.get(k) ?? 0) + 1);
    }
    const common = [...wrong.entries()].sort((x, y) => y[1] - x[1])[0];
    return {
      itemKey,
      answers: list.length,
      correctRate: list.filter((a) => a.correct).length / list.length,
      ...(common ? { commonWrong: common[0] } : {}),
      avgTimeMs: list.reduce((n, a) => n + a.timeMs, 0) / list.length,
    };
  });
}

const countBy = <T>(xs: readonly T[], key: (x: T) => string | null | undefined) => {
  const m = new Map<string, number>();
  for (const x of xs) {
    const k = key(x);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].map(([k, count]) => ({ key: k, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
};

export function registerOpsAdmin(app: FastifyInstance, deps: Deps) {
  const { repo, clock, audit, config } = deps;

  reg(app, deps, 'adminAnalyticsOverview', async (ctx) => {
    const q = ctx.query as { from?: string; to?: string };
    const to = q.to ? new Date(q.to) : clock.now();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * DAY);
    if (!(from < to)) fail('validation_failed', { detail: 'from must be before to' });
    const [events, attempts, messages] = await Promise.all([repo.listEvents({ from, to }), repo.listAttempts({ from, to }), repo.listTutorMessages({ from, to })]);
    const answers = attempts.length ? await repo.listAnswers({ attemptIds: attempts.map((a) => a.id) }) : [];

    // attempt owner → school (via class enrollment)
    const owners = [...new Set(attempts.map((a) => a.userId))];
    const enr = owners.length ? (await Promise.all(owners.map((u) => repo.listEnrollments({ userId: u, role: 'student' })))).flat() : [];
    const classes = enr.length ? (await repo.listClasses({ ids: [...new Set(enr.map((e) => e.classId))] }, { limit: 100_000 })).items : [];
    const classSchool = new Map(classes.map((c) => [c.id, c.schoolId]));
    const userSchool = new Map(enr.map((e) => [e.userId, classSchool.get(e.classId)]));
    const schools = (await repo.listSchools({ ids: [...new Set(classes.map((c) => c.schoolId))] }, { limit: 100_000 })).items;
    const region = new Map(schools.map((s) => [s.id, s.region]));

    const dayKeys: string[] = [];
    for (let t = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()); t < to.getTime(); t += DAY) dayKeys.push(new Date(t).toISOString().slice(0, 10));
    const evDay = countBy(events, (e) => e.ts.toISOString().slice(0, 10));
    const atDay = countBy(attempts, (a) => a.startedAt.toISOString().slice(0, 10));
    const get = (xs: { key: string; count: number }[], k: string) => xs.find((x) => x.key === k)?.count ?? 0;

    const threadMsgs = new Map<string, typeof messages>();
    for (const m of messages) threadMsgs.set(m.threadId, [...(threadMsgs.get(m.threadId) ?? []), m]);
    const unanswered: { topicKey: string; text: string; ts: string }[] = [];
    for (const list of threadMsgs.values()) {
      list.forEach((m, i) => {
        const reply = list[i + 1];
        if (m.role === 'user' && (!reply || (reply.role === 'assistant' && reply.flagged))) unanswered.push({ topicKey: m.topicKey, text: m.text.slice(0, 500), ts: iso(m.createdAt) });
      });
    }

    return {
      from: iso(from),
      to: iso(to),
      activeSchools: new Set([...userSchool.values()].filter(Boolean)).size,
      activeStudents: new Set(enr.map((e) => e.userId)).size,
      attempts: attempts.length,
      events: events.length,
      daily: dayKeys.map((d) => ({ date: d, events: get(evDay, d), attempts: get(atDay, d) })),
      bySchool: countBy(attempts, (a) => userSchool.get(a.userId)),
      byRegion: countBy(attempts, (a) => region.get(userSchool.get(a.userId) ?? '')),
      popularTopics: countBy(events, (e) => e.topicKey ?? (e.objectType === 'topic' ? e.objectKey : null)).slice(0, 20),
      popularConcepts: countBy(events.filter((e) => e.objectType === 'concept'), (e) => e.objectKey).slice(0, 20),
      hardestItems: itemStats(answers).sort((a, b) => a.correctRate - b.correctRate || a.itemKey.localeCompare(b.itemKey)).slice(0, 10),
      tutor: {
        questions: messages.filter((m) => m.role === 'user').length,
        refused: messages.filter((m) => m.role === 'assistant' && m.flagged).length,
        inputTokens: messages.reduce((n, m) => n + m.inputTokens, 0),
        outputTokens: messages.reduce((n, m) => n + m.outputTokens, 0),
        unanswered: unanswered.slice(-50),
      },
    };
  });

  async function auditScope(ctx: AnyCtx): Promise<((a: AuditRec) => boolean) | null> {
    if (isSuperadmin(ctx)) return null;
    const schools = adminSchools(ctx);
    const ids = new Set<string>(schools);
    for (const s of schools) {
      (await repo.listGrantsByScope('school', s)).forEach((g) => ids.add(g.userId));
      const cls = (await repo.listClasses({ schoolIds: [s] }, { limit: 100_000 })).items.map((c) => c.id);
      cls.forEach((c) => ids.add(c));
      if (cls.length) (await repo.listEnrollments({ classIds: cls })).forEach((e) => ids.add(e.userId));
    }
    return (a) => (!!a.actorId && ids.has(a.actorId)) || ids.has(a.targetId);
  }

  reg(app, deps, 'adminAudit', async (ctx) => {
    const q = ctx.query as { actorId?: string; action?: string; targetType?: string; cursor?: string; limit?: number };
    const scope = await auditScope(ctx);
    let rows = (await repo.listAudit({ actorId: q.actorId, action: q.action, targetType: q.targetType }, { limit: 1_000_000 })).items;
    if (scope) rows = rows.filter(scope);
    const page = pageArray(rows, pageOf(q), (a) => a.id);
    return {
      items: page.items.map((a) => ({
        id: a.id,
        actorId: a.actorId,
        action: a.action,
        targetType: a.targetType,
        targetId: a.targetId,
        ...(a.diff !== null && a.diff !== undefined ? { diff: a.diff } : {}),
        ...(a.ip ? { ip: a.ip } : {}),
        ts: iso(a.ts),
      })),
      nextCursor: page.nextCursor,
    };
  });

  reg(app, deps, 'adminTutorSettingsGet', async () => getTutorSettings(repo, config));

  reg(app, deps, 'adminTutorSettingsPut', async (ctx) => {
    const { version, ...value } = ctx.body as TutorSettings;
    if (version !== ctx.ifMatch) fail('validation_failed', { detail: 'body.version must equal If-Match' });
    const before = await getTutorSettings(repo, config);
    const r = await putTutorSettings(repo, value, ctx.ifMatch);
    if (r === 'not_found' || r === 'version_mismatch') fail('version_mismatch');
    await audit.log(ctx.auth.user!.id, 'tutor.settings_changed', { type: 'setting', id: 'tutor.settings' }, { ip: ctx.ip, diff: { before: { ...before, version: undefined }, after: value } });
    return r;
  });
}
