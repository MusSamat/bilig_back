/**
 * Admin: topics, versions, publish workflow, diff, checklist, tours and
 * comparisons (A-06, A-07, A-09, A-13). A topic row carries the optimistic
 * `version` used as If-Match for every write that creates a new TopicVersion.
 * Tours and comparisons live inside the topic document: PUT/DELETE write a
 * new draft version of the latest doc.
 */
import type { FastifyInstance } from 'fastify';
import { CONTENT_STATUSES, TopicSchema, type ContentStatus, type Topic } from '@bilig/content-model';
import { availableActions, type WorkflowAction } from '@bilig/content-model/api';
import type { Deps } from '../../deps.js';
import { fail, zodIssues } from '../../http/errors.js';
import { newId } from '../../ids.js';
import { diffJson } from '../../domain/diff.js';
import { nextVersion } from '../../domain/semver.js';
import { pageOf, sortedPage } from '../../repo/paging.js';
import type { TopicRec, TopicVersionRec } from '../../repo/types.js';
import { runWorkflow } from '../../services/workflow.js';
import { assertFields, authorFilter, authorizeSubject, checkBodyVersion, iso, optionalVersion, reg, semverSortKey, sortScalar, type AnyCtx } from './util.js';

export function registerTopicAdmin(app: FastifyInstance, deps: Deps) {
  const { repo, audit, clock } = deps;

  async function semverOf(id: string | null): Promise<string | undefined> {
    return id ? (await repo.getTopicVersion(id))?.version : undefined;
  }

  async function toAdminTopic(t: TopicRec) {
    const [pub, latest] = await Promise.all([semverOf(t.publishedVersionId), t.latestVersionId ? repo.getTopicVersion(t.latestVersionId) : null]);
    const updatedBy = t.updatedBy ?? latest?.authorId;
    return {
      id: t.id,
      key: t.key,
      unitKey: t.unitKey,
      status: t.status,
      ...(pub ? { publishedVersion: pub } : {}),
      ...(latest ? { latestVersion: latest.version, title: latest.doc.title, authorId: latest.authorId } : {}),
      updatedAt: iso(t.updatedAt),
      version: t.version,
      ...(updatedBy ? { updatedBy } : {}),
      createdAt: iso(t.createdAt),
    };
  }
  async function toDetail(t: TopicRec) {
    return {
      ...(await toAdminTopic(t)),
      demo: t.demo,
      subjectKey: t.subjectKey,
      ...(t.scheduledAt ? { scheduledAt: iso(t.scheduledAt) } : {}),
      availableActions: availableActions(t.status),
    };
  }
  const toVersionDto = (v: TopicVersionRec) => ({
    id: v.id,
    topicKey: v.topicKey,
    version: v.version,
    doc: v.doc,
    authorId: v.authorId,
    createdAt: iso(v.createdAt),
    reviewState: v.reviewState,
  });

  async function loadTopic(id: string) {
    const t = await repo.getTopic(id);
    if (!t) fail('not_found', { detail: 'topic' });
    return t;
  }
  async function loadTopicByKey(key: string) {
    const t = await repo.getTopicByKey(key);
    if (!t) fail('not_found', { detail: 'topic' });
    return t;
  }
  async function latestDoc(t: TopicRec): Promise<TopicVersionRec | null> {
    return t.latestVersionId ? repo.getTopicVersion(t.latestVersionId) : null;
  }
  async function subjectOfUnit(unitKey: string): Promise<string> {
    const unit = await repo.content('unit').get(unitKey);
    if (!unit) fail('validation_failed', { detail: `unknown unit ${unitKey}` });
    const course = await repo.content('course').get(unit.data.courseKey);
    if (!course) fail('validation_failed', { detail: `unknown course ${unit.data.courseKey}` });
    return course.data.subjectKey;
  }

  /** Create a new draft version (If-Match = topic.version). */
  // (also records the author as the topic's `updatedBy`)
  async function newVersion(ctx: AnyCtx, t: TopicRec, rawDoc: unknown, message?: string, basedOn?: string): Promise<TopicVersionRec> {
    authorizeSubject(ctx, 'content.draft.edit', t.subjectKey);
    if (t.version !== ctx.ifMatch) fail('version_mismatch');
    if (t.status === 'archived') fail('conflict', { detail: 'topic_archived' });
    const parsed = TopicSchema.safeParse({ ...(rawDoc as object), status: 'draft' });
    if (!parsed.success) fail('validation_failed', { issues: zodIssues(parsed.error) });
    const doc: Topic = parsed.data;
    if (doc.key !== t.key || doc.unitKey !== t.unitKey) fail('validation_failed', { detail: 'doc.key/unitKey must match the topic' });
    const latest = await latestDoc(t);
    if (basedOn && latest && latest.version !== basedOn) fail('version_mismatch', { detail: `latest is ${latest.version}` });
    assertFields(ctx, latest ? { ...latest.doc, status: 'draft' } : {}, doc, t.subjectKey);
    const versions = (await repo.listTopicVersions(t.id)).map((v) => v.version);
    const ver: TopicVersionRec = {
      id: newId(),
      topicId: t.id,
      topicKey: t.key,
      version: nextVersion(versions),
      doc,
      authorId: ctx.auth.user!.id,
      createdAt: clock.now(),
      reviewState: 'draft',
      message: message ?? null,
    };
    const created = await repo.createTopicVersion(ver);
    if (created === 'conflict') fail('conflict');
    const r = await repo.updateTopic(t.id, { latestVersionId: ver.id, status: 'draft', scheduledAt: null, scheduledVersionId: null, updatedBy: ctx.auth.user!.id }, ctx.ifMatch);
    if (r === 'not_found') fail('not_found');
    if (r === 'version_mismatch') fail('version_mismatch');
    await audit.log(ctx.auth.user!.id, 'content.updated', { type: 'topic', id: t.id }, { ip: ctx.ip, diff: { version: ver.version } });
    return created;
  }

  // --- topics -------------------------------------------------------------------
  reg(app, deps, 'adminTopicList', async (ctx) => {
    const q = ctx.query as { q?: string; subjectKey?: string; status?: string; cursor?: string; limit?: number; sort?: string; order?: 'asc' | 'desc'; unitKey?: string; authorId?: string; mine?: boolean };
    const status = q.status && (CONTENT_STATUSES as readonly string[]).includes(q.status) ? (q.status as ContentStatus) : undefined;
    if (q.status && !status) fail('validation_failed', { detail: 'status' });
    const author = authorFilter(ctx, q);
    if (!q.unitKey && !author && !q.sort && q.order !== 'desc') {
      const res = await repo.listTopics({ q: q.q, subjectKey: q.subjectKey, status }, pageOf(q));
      return { items: await Promise.all(res.items.map(toAdminTopic)), nextCursor: res.nextCursor };
    }
    // v0.3.0: unit / author filters and sorting over the filtered rows.
    const all = (await repo.listTopics({ q: q.q, subjectKey: q.subjectKey, status }, { limit: 100_000 })).items.filter((t) => !q.unitKey || t.unitKey === q.unitKey);
    const rows = (await Promise.all(all.map(toAdminTopic))).filter((t) => !author || t.authorId === author);
    type Row = (typeof rows)[number];
    const value = (r: Row) => {
      switch (q.sort ?? 'key') {
        case 'publishedVersion':
        case 'latestVersion':
          return semverSortKey(r[q.sort as 'publishedVersion' | 'latestVersion']);
        case 'title':
          return sortScalar(r.title, ctx.lang);
        default:
          return sortScalar((r as Record<string, unknown>)[q.sort ?? 'key'], ctx.lang);
      }
    };
    return sortedPage(rows, { value, tie: (r) => r.key, order: q.order }, pageOf(q));
  });

  reg(app, deps, 'adminTopicCreate', async (ctx) => {
    const body = ctx.body as { key: string; unitKey: string };
    const subjectKey = await subjectOfUnit(body.unitKey);
    authorizeSubject(ctx, 'content.draft.edit', subjectKey);
    const created = await repo.createTopic({
      id: newId(),
      key: body.key,
      unitKey: body.unitKey,
      subjectKey,
      status: 'draft',
      demo: false,
      publishedVersionId: null,
      latestVersionId: null,
      scheduledAt: null,
      scheduledVersionId: null,
      updatedBy: ctx.auth.user!.id,
    });
    if (created === 'conflict') fail('conflict', { detail: 'topic exists' });
    await audit.log(ctx.auth.user!.id, 'content.created', { type: 'topic', id: created.id }, { ip: ctx.ip, diff: { key: body.key } });
    return toAdminTopic(created);
  });

  reg(app, deps, 'adminTopicGet', async (ctx) => toDetail(await loadTopic(ctx.params.id)));

  reg(app, deps, 'adminTopicPatch', async (ctx) => {
    checkBodyVersion(ctx);
    const t = await loadTopic(ctx.params.id);
    authorizeSubject(ctx, 'content.draft.edit', t.subjectKey);
    const body = ctx.body as { unitKey?: string; demo?: boolean };
    const patch: Parameters<typeof repo.updateTopic>[1] = {};
    if (body.unitKey && body.unitKey !== t.unitKey) {
      const subjectKey = await subjectOfUnit(body.unitKey);
      authorizeSubject(ctx, 'content.draft.edit', subjectKey);
      patch.unitKey = body.unitKey;
      patch.subjectKey = subjectKey;
    }
    if (body.demo !== undefined) patch.demo = body.demo;
    patch.updatedBy = ctx.auth.user!.id;
    const r = await repo.updateTopic(t.id, patch, ctx.ifMatch);
    if (r === 'not_found') fail('not_found');
    if (r === 'version_mismatch') fail('version_mismatch');
    deps.content.invalidate();
    await audit.log(ctx.auth.user!.id, 'content.updated', { type: 'topic', id: t.id }, { ip: ctx.ip, diff: body });
    return toDetail(r);
  });

  reg(app, deps, 'adminTopicDelete', async (ctx) => {
    const t = await loadTopic(ctx.params.id);
    authorizeSubject(ctx, 'content.publish', t.subjectKey);
    const r = await repo.updateTopic(t.id, { deletedAt: clock.now(), publishedVersionId: null, scheduledAt: null, scheduledVersionId: null, updatedBy: ctx.auth.user!.id }, ctx.ifMatch);
    if (r === 'not_found') fail('not_found');
    if (r === 'version_mismatch') fail('version_mismatch');
    deps.content.invalidate();
    await audit.log(ctx.auth.user!.id, 'content.deleted', { type: 'topic', id: t.id }, { ip: ctx.ip, diff: { key: t.key } });
    return { ok: true as const };
  });

  // --- versions -------------------------------------------------------------------
  reg(app, deps, 'adminTopicVersionCreate', async (ctx) => {
    checkBodyVersion(ctx);
    const t = await loadTopic(ctx.params.id);
    const body = ctx.body as { doc: Topic; basedOn?: string; message?: string };
    return toVersionDto(await newVersion(ctx, t, body.doc, body.message, body.basedOn));
  });

  reg(app, deps, 'adminTopicVersions', async (ctx) => {
    const t = await loadTopic(ctx.params.id);
    const items = await repo.listTopicVersions(t.id);
    return {
      items: items.map((v) => {
        const { doc: _doc, ...rest } = toVersionDto(v);
        return rest;
      }),
    };
  });

  reg(app, deps, 'adminTopicVersionGet', async (ctx) => {
    const t = await loadTopic(ctx.params.id);
    const v = await repo.getTopicVersionBySemver(t.id, ctx.params.version);
    if (!v) fail('not_found', { detail: 'version' });
    return toVersionDto(v);
  });

  reg(app, deps, 'adminTopicDiff', async (ctx) => {
    const t = await loadTopic(ctx.params.id);
    const q = ctx.query as { from?: string; to?: string };
    const pick = async (semver: string | undefined, fallbackId: string | null) => {
      if (semver) {
        const v = await repo.getTopicVersionBySemver(t.id, semver);
        if (!v) fail('not_found', { detail: `version ${semver}` });
        return v;
      }
      return fallbackId ? repo.getTopicVersion(fallbackId) : null;
    };
    const to = await pick(q.to, t.latestVersionId);
    if (!to) fail('not_found', { detail: 'no versions' });
    const from = await pick(q.from, t.publishedVersionId);
    return { from: from?.version ?? null, to: to.version, changes: diffJson(from?.doc ?? {}, to.doc) };
  });

  reg(app, deps, 'adminTopicChecklist', async (ctx) => {
    const t = await loadTopic(ctx.params.id);
    const ver = await latestDoc(t);
    if (!ver) fail('not_found', { detail: 'no versions' });
    return deps.content.publishing.checklist(await deps.content.publishing.assemble(t, ver));
  });

  // --- workflow -------------------------------------------------------------------
  const flows: [Parameters<typeof reg>[2], WorkflowAction, 'content.draft.edit' | 'content.publish'][] = [
    ['adminTopicSubmit', 'submit', 'content.draft.edit'],
    ['adminTopicReject', 'reject', 'content.publish'],
    ['adminTopicApprove', 'approve', 'content.publish'],
    ['adminTopicPublish', 'publish', 'content.publish'],
    ['adminTopicArchive', 'archive', 'content.publish'],
    ['adminTopicRestore', 'restore', 'content.publish'],
    ['adminTopicRollback', 'rollback', 'content.publish'],
  ];
  for (const [name, action, perm] of flows) {
    reg(app, deps, name, async (ctx) => {
      const t = await loadTopic(ctx.params.id);
      authorizeSubject(ctx, perm, t.subjectKey);
      const b = (ctx.body ?? {}) as { message?: string; reason?: string; scheduledAt?: string; toVersion?: string };
      return runWorkflow(deps, t, action, {
        actorId: ctx.auth.user!.id,
        ip: ctx.ip,
        message: b.message,
        reason: b.reason,
        scheduledAt: b.scheduledAt ? new Date(b.scheduledAt) : undefined,
        toVersion: b.toVersion,
      });
    });
  }

  // v0.3.0: cancel a scheduled publish (A-13). The topic stays in review.
  reg(app, deps, 'adminTopicScheduleCancel', async (ctx) => {
    const t = await loadTopic(ctx.params.id);
    authorizeSubject(ctx, 'content.publish', t.subjectKey);
    const expected = optionalVersion(ctx);
    if (expected !== null && expected !== t.version) fail('version_mismatch');
    if (!t.scheduledAt) fail('conflict', { detail: 'not_scheduled' });
    const ver = t.scheduledVersionId ? await repo.getTopicVersion(t.scheduledVersionId) : null;
    const r = await repo.updateTopic(t.id, { scheduledAt: null, scheduledVersionId: null, updatedBy: ctx.auth.user!.id }, t.version);
    if (r === 'not_found') fail('not_found');
    if (r === 'version_mismatch') fail('version_mismatch');
    await audit.log(ctx.auth.user!.id, 'content.schedule_cancelled', { type: 'topic', id: t.id }, { ip: ctx.ip, diff: { version: ver?.version, scheduledAt: iso(t.scheduledAt) } });
    const latest = await latestDoc(r);
    return { topicKey: r.key, status: r.status, version: ver?.version ?? latest?.version ?? '0.0.0' };
  });

  // --- tours & comparisons (inside the topic doc) ------------------------------------
  const activity = (field: 'tour' | 'comparison', names: { get: Parameters<typeof reg>[2]; put: Parameters<typeof reg>[2]; del: Parameters<typeof reg>[2] }) => {
    reg(app, deps, names.get, async (ctx) => {
      const t = await loadTopicByKey(ctx.params.topicKey);
      const v = await latestDoc(t);
      return { topicKey: t.key, [field]: v?.doc.activities[field] ?? null, version: v?.version ?? null };
    });
    const write = async (ctx: AnyCtx, value: unknown) => {
      const t = await loadTopicByKey(ctx.params.topicKey);
      const v = await latestDoc(t);
      if (!v) fail('conflict', { detail: 'topic_has_no_versions' });
      const activities = { ...v.doc.activities, [field]: value };
      if (value === undefined) delete (activities as Record<string, unknown>)[field];
      return toVersionDto(await newVersion(ctx, t, { ...v.doc, activities }, `${field} ${value === undefined ? 'removed' : 'updated'}`));
    };
    reg(app, deps, names.put, async (ctx) => {
      checkBodyVersion(ctx);
      return write(ctx, (ctx.body as Record<string, unknown>)[field]);
    });
    reg(app, deps, names.del, async (ctx) => write(ctx, undefined));
  };
  activity('tour', { get: 'adminTourGet', put: 'adminTourPut', del: 'adminTourDelete' });
  activity('comparison', { get: 'adminComparisonGet', put: 'adminComparisonPut', del: 'adminComparisonDelete' });
}
