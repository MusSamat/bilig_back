/**
 * Publish workflow (A-13): draft → review → published → archived, using the
 * shared WORKFLOW transition table. Publishing builds a package and moves the
 * topic's published pointer; the catalog cache is invalidated. Scheduled
 * publishes are executed by `runScheduledPublishes` (timer in main.ts).
 */
import { transition, type Checklist, type WorkflowAction, type WorkflowResponse } from '@bilig/content-model/api';
import type { Deps } from '../deps.js';
import { fail } from '../http/errors.js';
import { newId } from '../ids.js';
import type { TopicRec, TopicVersionRec } from '../repo/types.js';
import { PublishingService } from './publishing.js';

export interface WorkflowInput {
  actorId: string;
  ip?: string;
  message?: string;
  reason?: string;
  scheduledAt?: Date;
  toVersion?: string;
}

async function latestVersion(deps: Deps, topic: TopicRec): Promise<TopicVersionRec> {
  const v = topic.latestVersionId ? await deps.repo.getTopicVersion(topic.latestVersionId) : null;
  if (!v) fail('conflict', { detail: 'topic_has_no_versions' });
  return v;
}

const respond = (topic: TopicRec, version: string, checklist?: Checklist): WorkflowResponse => ({
  topicKey: topic.key,
  status: topic.status,
  version,
  ...(checklist ? { checklist } : {}),
  ...(topic.scheduledAt ? { scheduledAt: topic.scheduledAt.toISOString() } : {}),
});

async function save(deps: Deps, topic: TopicRec, patch: Parameters<Deps['repo']['updateTopic']>[1]): Promise<TopicRec> {
  const r = await deps.repo.updateTopic(topic.id, patch, topic.version);
  if (r === 'not_found') fail('not_found', { detail: 'topic' });
  if (r === 'version_mismatch') fail('version_mismatch');
  return r;
}

/** Publish a version now: build → pointer → cache. Throws 409 with the checklist when it fails. */
export async function publishVersion(deps: Deps, topic: TopicRec, ver: TopicVersionRec, input: WorkflowInput, action: 'publish' | 'rollback' = 'publish') {
  const { build, checklist } = await deps.content.publishing.build(topic, ver);
  if (build.status !== 'ready') fail('conflict', { detail: 'checklist_failed', issues: checklist.issues.filter((i) => i.severity === 'error').slice(0, 50).map((i) => ({ path: i.path, message: `${i.code}: ${i.message}` })) });
  const prev = topic.publishedVersionId;
  if (prev && prev !== ver.id) {
    const pv = await deps.repo.getTopicVersion(prev);
    if (pv && pv.reviewState === 'published') await deps.repo.updateTopicVersion(prev, { reviewState: 'archived' });
  }
  await deps.repo.updateTopicVersion(ver.id, { reviewState: 'published' });
  const latest = topic.latestVersionId === ver.id || action === 'publish';
  const next = await save(deps, topic, {
    status: latest || action === 'rollback' ? 'published' : topic.status,
    publishedVersionId: ver.id,
    scheduledAt: null,
    scheduledVersionId: null,
  });
  deps.content.invalidate();
  await deps.audit.log(input.actorId, action === 'rollback' ? 'content.rollback' : 'content.publish', { type: 'topic', id: topic.id }, {
    ip: input.ip,
    diff: { topicKey: topic.key, version: ver.version, hash: build.hash, previousVersionId: prev },
  });
  return respond(next, ver.version, checklist);
}

export async function runWorkflow(deps: Deps, topic: TopicRec, action: WorkflowAction, input: WorkflowInput): Promise<WorkflowResponse> {
  if (action !== 'rollback' && !transition(topic.status, action)) fail('conflict', { detail: `cannot ${action} from ${topic.status}` });
  switch (action) {
    case 'submit': {
      const ver = await latestVersion(deps, topic);
      const res = await deps.content.publishing.assemble(topic, ver);
      const checklist = deps.content.publishing.checklist(res);
      if (!checklist.schema) fail('conflict', { detail: 'checklist_failed', issues: checklist.issues.filter((i) => i.severity === 'error').slice(0, 50).map((i) => ({ path: i.path, message: `${i.code}: ${i.message}` })) });
      await deps.repo.updateTopicVersion(ver.id, { reviewState: 'review' });
      const next = await save(deps, topic, { status: 'review' });
      await deps.audit.log(input.actorId, 'content.submit', { type: 'topic', id: topic.id }, { ip: input.ip, diff: { version: ver.version, message: input.message } });
      return respond(next, ver.version, checklist);
    }
    case 'reject': {
      const ver = await latestVersion(deps, topic);
      await deps.repo.updateTopicVersion(ver.id, { reviewState: 'draft' });
      await deps.repo.createReviewComment({ id: newId(), targetType: 'topic', targetId: topic.id, path: '', body: input.reason ?? '', authorId: input.actorId, createdAt: deps.clock.now(), resolvedAt: null });
      const next = await save(deps, topic, { status: 'draft', scheduledAt: null, scheduledVersionId: null });
      await deps.audit.log(input.actorId, 'content.reject', { type: 'topic', id: topic.id }, { ip: input.ip, diff: { version: ver.version, reason: input.reason } });
      return respond(next, ver.version);
    }
    case 'approve':
    case 'publish': {
      const ver = await latestVersion(deps, topic);
      if (input.scheduledAt && input.scheduledAt.getTime() > deps.clock.now().getTime()) {
        const res = await deps.content.publishing.assemble(topic, ver);
        const checklist = deps.content.publishing.checklist(res);
        if (!PublishingService.passes(checklist)) fail('conflict', { detail: 'checklist_failed', issues: checklist.issues.filter((i) => i.severity === 'error').slice(0, 50).map((i) => ({ path: i.path, message: `${i.code}: ${i.message}` })) });
        const next = await save(deps, topic, { scheduledAt: input.scheduledAt, scheduledVersionId: ver.id });
        await deps.audit.log(input.actorId, 'content.schedule', { type: 'topic', id: topic.id }, { ip: input.ip, diff: { version: ver.version, scheduledAt: input.scheduledAt.toISOString() } });
        return respond(next, ver.version, checklist);
      }
      return publishVersion(deps, topic, ver, input);
    }
    case 'archive': {
      const next = await save(deps, topic, { status: 'archived', publishedVersionId: null, scheduledAt: null, scheduledVersionId: null });
      if (topic.publishedVersionId) await deps.repo.updateTopicVersion(topic.publishedVersionId, { reviewState: 'archived' });
      deps.content.invalidate();
      await deps.audit.log(input.actorId, 'content.archive', { type: 'topic', id: topic.id }, { ip: input.ip, diff: { reason: input.reason } });
      return respond(next, (await latestVersion(deps, topic)).version);
    }
    case 'restore': {
      const next = await save(deps, topic, { status: 'draft' });
      await deps.audit.log(input.actorId, 'content.restore', { type: 'topic', id: topic.id }, { ip: input.ip });
      return respond(next, (await latestVersion(deps, topic)).version);
    }
    case 'rollback': {
      if (!transition(topic.status, 'rollback') && !topic.publishedVersionId) fail('conflict', { detail: `cannot rollback from ${topic.status}` });
      if (!input.toVersion) fail('validation_failed', { detail: 'toVersion' });
      const ver = await deps.repo.getTopicVersionBySemver(topic.id, input.toVersion);
      if (!ver) fail('not_found', { detail: 'version' });
      if (ver.id === topic.publishedVersionId) fail('conflict', { detail: 'already_published' });
      // Prefer the exact package that was published before (byte-identical rollback).
      const prior = await deps.repo.readyBuildForVersion(ver.id);
      if (prior) {
        const prev = topic.publishedVersionId;
        if (prev) await deps.repo.updateTopicVersion(prev, { reviewState: 'archived' });
        await deps.repo.updateTopicVersion(ver.id, { reviewState: 'published' });
        const next = await save(deps, topic, { status: 'published', publishedVersionId: ver.id, scheduledAt: null, scheduledVersionId: null });
        deps.content.invalidate();
        await deps.audit.log(input.actorId, 'content.rollback', { type: 'topic', id: topic.id }, { ip: input.ip, diff: { topicKey: topic.key, version: ver.version, previousVersionId: prev } });
        return respond(next, ver.version);
      }
      return publishVersion(deps, topic, ver, input, 'rollback');
    }
  }
}

/** Execute due scheduled publishes. Returns the number published. */
export async function runScheduledPublishes(deps: Deps): Promise<number> {
  const due = await deps.repo.listTopics({ scheduledBefore: deps.clock.now() }, { limit: 100 });
  let n = 0;
  for (const t of due.items) {
    if (!t.scheduledVersionId) continue;
    const ver = await deps.repo.getTopicVersion(t.scheduledVersionId);
    if (!ver) continue;
    try {
      await publishVersion(deps, t, ver, { actorId: ver.authorId });
      n++;
    } catch {
      await deps.repo.updateTopic(t.id, { scheduledAt: null, scheduledVersionId: null }, null);
    }
  }
  return n;
}
