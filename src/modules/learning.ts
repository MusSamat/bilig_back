/**
 * Learning (TZ §9): progress, attempts with SERVER-side checking
 * (checkAnswer from the published package — the client's verdict is never
 * trusted), offline sync (Idempotency-Key + clientId dedupe), xAPI events
 * stored under an HMAC pseudonym.
 */
import type { FastifyInstance } from 'fastify';
import { checkAnswer, sampleItems, type ContentPackage, type Item } from '@bilig/content-model';
import type { Attempt, AttemptResult, LearningEvent, OfflineAttempt, Progress, SyncResponse } from '@bilig/content-model/api';
import { newId } from '../ids.js';
import type { Deps } from '../deps.js';
import { route } from '../http/route.js';
import { fail } from '../http/errors.js';
import { pseudonym, sha256Hex, stableStringify } from '../domain/crypto.js';
import type { AnswerRec, AttemptRec, LearningEventRec, ProgressRec } from '../repo/types.js';

const iso = (d: Date) => d.toISOString();

export function toAttemptDto(a: AttemptRec): Attempt {
  return {
    id: a.id,
    clientId: a.clientId,
    topicKey: a.topicKey,
    topicVersion: a.topicVersion,
    ...(a.assignmentId ? { assignmentId: a.assignmentId } : {}),
    itemKeys: a.itemKeys,
    startedAt: iso(a.startedAt),
    ...(a.finishedAt ? { finishedAt: iso(a.finishedAt) } : {}),
    ...(a.score !== null ? { score: a.score } : {}),
  };
}

const toProgressDto = (p: ProgressRec): Progress => ({
  topicKey: p.topicKey,
  visitedConcepts: p.visitedConcepts,
  completedActivities: p.completedActivities,
  updatedAt: iso(p.updatedAt),
});

const union = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])];

export function registerLearning(app: FastifyInstance, deps: Deps) {
  const { repo, clock, content, config, limiter } = deps;

  /** The package of a specific topic version (current or historical build). */
  async function packageFor(topicKey: string, version: string): Promise<{ pkg: ContentPackage; versionId: string } | null> {
    const topic = await repo.getTopicByKey(topicKey);
    if (!topic) return null;
    const ver = await repo.getTopicVersionBySemver(topic.id, version);
    if (!ver) return null;
    const build = await repo.readyBuildForVersion(ver.id);
    return build?.pkg ? { pkg: build.pkg, versionId: ver.id } : null;
  }

  async function assertAssignment(userId: string, assignmentId: string | undefined, topicKey: string) {
    if (!assignmentId) return;
    const a = await repo.getAssignment(assignmentId);
    if (!a || a.topicKey !== topicKey) fail('validation_failed', { detail: 'assignment' });
    const enr = await repo.listEnrollments({ classId: a.classId, userId });
    if (!enr.length) fail('forbidden', { detail: 'assignment' });
  }

  const drawItems = (pkg: ContentPackage, seed: string) => {
    const quiz = pkg.topic.activities.quiz;
    return quiz ? sampleItems(quiz.itemKeys, quiz.sampleSize, seed) : [];
  };

  async function mergeProgress(userId: string, topicKey: string, visited: string[], completed: string[], at: Date): Promise<ProgressRec> {
    const cur = await repo.getProgress(userId, topicKey);
    const next: ProgressRec = {
      userId,
      topicKey,
      visitedConcepts: union(cur?.visitedConcepts ?? [], visited),
      completedActivities: union(cur?.completedActivities ?? [], completed),
      updatedAt: cur && cur.updatedAt > at ? cur.updatedAt : at,
    };
    await repo.putProgress(next);
    return next;
  }

  // --- progress ---------------------------------------------------------------------
  route(app, deps, 'progressGet', async ({ params, userId }) => {
    const uid = userId();
    const p = await repo.getProgress(uid, params.topicKey);
    return p ? toProgressDto(p) : { topicKey: params.topicKey, visitedConcepts: [], completedActivities: [], updatedAt: iso(new Date(0)) };
  });

  route(app, deps, 'progressPut', async ({ params, body, userId }) => {
    const uid = userId();
    if (!(await content.getPublished(params.topicKey))) fail('not_found', { detail: 'topic' });
    const p = await mergeProgress(uid, params.topicKey, body.visitedConcepts, body.completedActivities, clock.now());
    return toProgressDto(p);
  });

  // --- attempts ---------------------------------------------------------------------
  route(app, deps, 'attemptCreate', async ({ body, userId }) => {
    const uid = userId();
    const dup = await repo.getAttemptByClientId(uid, body.clientId);
    if (dup) return toAttemptDto(dup); // retry of the same create is idempotent
    const found = await packageFor(body.topicKey, body.topicVersion);
    if (!found) fail('not_found', { detail: 'topic_version' });
    if (!found.pkg.topic.activities.quiz) fail('validation_failed', { detail: 'topic_has_no_quiz' });
    await assertAssignment(uid, body.assignmentId, body.topicKey);
    const rec: AttemptRec = {
      id: newId(),
      userId: uid,
      clientId: body.clientId,
      assignmentId: body.assignmentId ?? null,
      topicKey: body.topicKey,
      topicVersion: body.topicVersion,
      topicVersionId: found.versionId,
      seed: body.seed,
      itemKeys: drawItems(found.pkg, body.seed),
      startedAt: clock.now(),
      finishedAt: null,
      score: null,
      source: 'online',
    };
    const created = await repo.createAttempt(rec);
    if (created === 'conflict') return toAttemptDto((await repo.getAttemptByClientId(uid, body.clientId))!);
    return toAttemptDto(created);
  });

  async function ownAttempt(uid: string, id: string) {
    const a = await repo.getAttempt(id);
    if (!a || a.userId !== uid) fail('not_found', { detail: 'attempt' });
    return a;
  }

  async function itemsOf(a: AttemptRec): Promise<Map<string, Item>> {
    const found = await packageFor(a.topicKey, a.topicVersion);
    if (!found) fail('not_found', { detail: 'topic_version' });
    return new Map(found.pkg.items.map((i) => [i.key, i]));
  }

  route(app, deps, 'attemptAnswer', async ({ params, body, userId }) => {
    const uid = userId();
    const a = await ownAttempt(uid, params.id);
    if (a.finishedAt) fail('conflict', { detail: 'attempt_finished' });
    if (!a.itemKeys.includes(body.itemKey)) fail('validation_failed', { detail: 'item_not_in_attempt' });
    const item = (await itemsOf(a)).get(body.itemKey);
    if (!item) fail('not_found', { detail: 'item' });
    const r = checkAnswer(item, body.response);
    const created = await repo.createAnswer({
      id: newId(),
      attemptId: a.id,
      itemKey: body.itemKey,
      response: body.response,
      correct: r.correct,
      score: r.score,
      timeMs: body.timeMs,
      answeredAt: clock.now(),
    });
    // First answer wins: a resubmission returns the stored verdict.
    const stored = created === 'conflict' ? (await repo.listAnswers({ attemptIds: [a.id], itemKey: body.itemKey }))[0] : created;
    return { itemKey: stored.itemKey, correct: stored.correct, score: stored.score, explanation: item.explanation };
  });

  async function result(a: AttemptRec): Promise<AttemptResult> {
    const items = await itemsOf(a);
    const answers = await repo.listAnswers({ attemptIds: [a.id] });
    return {
      attempt: toAttemptDto(a),
      correctCount: answers.filter((x) => x.correct).length,
      total: a.itemKeys.length,
      answers: answers.map((x) => ({ itemKey: x.itemKey, correct: x.correct, score: x.score, ...(items.get(x.itemKey) ? { explanation: items.get(x.itemKey)!.explanation } : {}) })),
    };
  }

  const scoreOf = (itemKeys: string[], answers: Pick<AnswerRec, 'itemKey' | 'score'>[]) =>
    itemKeys.length ? answers.filter((x) => itemKeys.includes(x.itemKey)).reduce((n, x) => n + x.score, 0) / itemKeys.length : 0;

  route(app, deps, 'attemptFinish', async ({ params, userId }) => {
    const uid = userId();
    let a = await ownAttempt(uid, params.id);
    if (!a.finishedAt) {
      const answers = await repo.listAnswers({ attemptIds: [a.id] });
      a = (await repo.updateAttempt(a.id, { finishedAt: clock.now(), score: scoreOf(a.itemKeys, answers) }))!;
    }
    return result(a);
  });

  // --- offline sync ---------------------------------------------------------------------
  async function syncAttempt(uid: string, o: OfflineAttempt): Promise<SyncResponse['attempts'][number]> {
    const dup = await repo.getAttemptByClientId(uid, o.clientId);
    if (dup) return { clientId: o.clientId, status: 'duplicate', id: dup.id, ...(dup.score !== null ? { score: dup.score } : {}) };
    const found = await packageFor(o.topicKey, o.topicVersion);
    if (!found) return { clientId: o.clientId, status: 'rejected', reason: 'topic_version_unknown' };
    // Items must be the deterministic sample for the seed — no cherry-picking offline.
    const expected = drawItems(found.pkg, o.seed);
    if (expected.length === 0 || expected.join('|') !== o.itemKeys.join('|')) return { clientId: o.clientId, status: 'rejected', reason: 'items_mismatch' };
    if (o.assignmentId) {
      const a = await repo.getAssignment(o.assignmentId);
      const enr = a ? await repo.listEnrollments({ classId: a.classId, userId: uid }) : [];
      if (!a || a.topicKey !== o.topicKey || !enr.length) return { clientId: o.clientId, status: 'rejected', reason: 'assignment' };
    }
    const items = new Map(found.pkg.items.map((i) => [i.key, i]));
    const now = clock.now();
    const startedAt = new Date(o.startedAt);
    const rec: AttemptRec = {
      id: newId(),
      userId: uid,
      clientId: o.clientId,
      assignmentId: o.assignmentId ?? null,
      topicKey: o.topicKey,
      topicVersion: o.topicVersion,
      topicVersionId: found.versionId,
      seed: o.seed,
      itemKeys: o.itemKeys,
      startedAt: startedAt > now ? now : startedAt,
      finishedAt: null,
      score: null,
      source: 'sync',
    };
    const created = await repo.createAttempt(rec);
    if (created === 'conflict') {
      const again = (await repo.getAttemptByClientId(uid, o.clientId))!;
      return { clientId: o.clientId, status: 'duplicate', id: again.id };
    }
    const seen = new Set<string>();
    const scored: { itemKey: string; score: number }[] = [];
    for (const ans of o.answers) {
      const item = items.get(ans.itemKey);
      if (!item || !o.itemKeys.includes(ans.itemKey) || seen.has(ans.itemKey)) continue;
      seen.add(ans.itemKey);
      const r = checkAnswer(item, ans.response); // server-side re-check
      const answeredAt = new Date(ans.answeredAt);
      await repo.createAnswer({ id: newId(), attemptId: rec.id, itemKey: ans.itemKey, response: ans.response, correct: r.correct, score: r.score, timeMs: ans.timeMs, answeredAt: answeredAt > now ? now : answeredAt });
      scored.push({ itemKey: ans.itemKey, score: r.score });
    }
    let score: number | undefined;
    if (o.finishedAt) {
      score = scoreOf(o.itemKeys, scored);
      const fin = new Date(o.finishedAt);
      await repo.updateAttempt(rec.id, { finishedAt: fin > now ? now : fin, score });
    }
    return { clientId: o.clientId, status: 'created', id: rec.id, ...(score !== undefined ? { score } : {}) };
  }

  function toEventRecs(actor: string, events: readonly LearningEvent[]): LearningEventRec[] {
    const now = clock.now();
    return events.map((e) => ({
      id: e.id,
      actor,
      verb: e.verb,
      objectType: e.object.type,
      objectKey: e.object.key,
      topicKey: e.topicKey ?? null,
      result: e.result ?? null,
      // context is free-form from the client: keep it small and never trust it for identity
      context: e.context && JSON.stringify(e.context).length <= 2000 ? e.context : null,
      ts: new Date(e.ts) > now ? now : new Date(e.ts),
      receivedAt: now,
    }));
  }

  route(
    app,
    deps,
    'sync',
    async ({ body, userId, idempotencyKey }) => {
      const uid = userId();
      const requestHash = sha256Hex(stableStringify(body));
      const prior = await repo.getIdempotency(uid, idempotencyKey);
      if (prior) {
        if (prior.requestHash !== requestHash) fail('idempotency_conflict');
        return prior.response as SyncResponse;
      }
      const attempts = [];
      for (const o of body.attempts) attempts.push(await syncAttempt(uid, o));
      const progress: Progress[] = [];
      for (const p of body.progress) {
        if (!(await content.getPublished(p.topicKey))) continue;
        progress.push(toProgressDto(await mergeProgress(uid, p.topicKey, p.visitedConcepts, p.completedActivities, new Date(p.updatedAt))));
      }
      const events = body.events.length
        ? await repo.insertEvents(toEventRecs(pseudonym(config.pseudonymSecret, uid), body.events))
        : { accepted: 0, duplicates: 0 };
      const response: SyncResponse = { attempts, progress, events };
      if (!(await repo.putIdempotency({ userId: uid, key: idempotencyKey, requestHash, response, createdAt: clock.now() }))) {
        const raced = await repo.getIdempotency(uid, idempotencyKey);
        if (raced && raced.requestHash === requestHash) return raced.response as SyncResponse;
      }
      return response;
    },
    { bodyLimit: 4 * 1024 * 1024 },
  );

  // POST /events — xAPI batches; guests allowed (actor = 'guest'), rate limited per IP
  route(app, deps, 'events', async ({ body, auth, ip }) => {
    const r = await limiter.hit(`events:ip:${ip}`, 120, 60);
    if (!r.allowed) fail('rate_limited', { retryAfter: r.retryAfter });
    const actor = auth.user ? pseudonym(config.pseudonymSecret, auth.user.id) : 'guest';
    return repo.insertEvents(toEventRecs(actor, body.events));
  }, { bodyLimit: 2 * 1024 * 1024 });
}
