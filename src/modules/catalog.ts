/**
 * Catalog (TZ §9): subjects, courses, topic manifests (hash-addressed
 * packages, licence/demo gate), multilingual search. Responses are localised
 * by Accept-Language with the ky → ru → en chain (empty locales are filled).
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Lang } from '@bilig/content-model';
import type { Deps } from '../deps.js';
import { route } from '../http/route.js';
import { fail } from '../http/errors.js';
import { localizeDeep } from '../domain/lang.js';
import type { AuthCtx } from '../http/auth-context.js';

export function registerCatalog(app: FastifyInstance, deps: Deps) {
  const { content, repo } = deps;

  const localized = (reply: FastifyReply, lang: Lang) =>
    reply.header('Content-Language', lang).header('Vary', 'Accept-Language, Authorization').header('Cache-Control', 'public, max-age=60');

  route(app, deps, 'catalog', async ({ reply, lang }) => {
    localized(reply, lang);
    return content.catalog(lang);
  });

  route(app, deps, 'subjects', async ({ reply, lang }) => {
    localized(reply, lang);
    const c = await content.catalog(lang);
    return { groups: c.groups, subjects: c.subjects };
  });

  route(app, deps, 'subjectCourses', async ({ reply, lang, params }) => {
    const c = await content.catalog(lang);
    if (!c.subjects.some((s) => s.key === params.key)) fail('not_found', { detail: 'subject' });
    localized(reply, lang);
    return { items: c.courses.filter((x) => x.subjectKey === params.key) };
  });

  route(app, deps, 'course', async ({ reply, lang, params }) => {
    const c = await content.catalog(lang);
    const course = c.courses.find((x) => x.key === params.key);
    if (!course) fail('not_found', { detail: 'course' });
    const units = c.units.filter((u) => u.courseKey === course.key);
    const unitKeys = new Set(units.map((u) => u.key));
    const objectives = (await repo.content('objective').list({ subjectKey: course.subjectKey }, { limit: 10_000 })).items
      .map((r) => r.data)
      .filter((o) => unitKeys.has(o.unitKey));
    localized(reply, lang);
    return {
      course,
      units,
      objectives: localizeDeep(objectives, lang),
      topics: c.topics.filter((t) => unitKeys.has(t.unitKey)),
    };
  });

  async function gate(auth: AuthCtx, key: string) {
    const pub = await content.getPublished(key);
    if (!pub) fail('not_found', { detail: 'topic' });
    const verdict = await content.canOpen(auth, pub);
    if (verdict !== 'ok') fail(verdict, { detail: 'license_required', i18nKey: 'errors.license_required' });
    return pub;
  }

  route(app, deps, 'topicManifest', async ({ auth, params, reply }) => {
    const pub = await gate(auth, params.key);
    reply.header('Cache-Control', 'private, no-cache').header('Vary', 'Authorization');
    return {
      manifest: pub.build.manifest,
      packageUrl: pub.build.packageUrl ?? content.publishing.packageUrl(pub.topic.key, pub.build.manifest.hash),
      filesBaseUrl: content.publishing.filesBaseUrl(pub.build.manifest.hash),
    };
  });

  // Dev / offline-server stand-in for the CDN: immutable when addressed by hash.
  route(app, deps, 'topicPackage', async ({ auth, params, reply, req }) => {
    const pub = await gate(auth, params.key);
    const v = (req.query as { v?: string }).v;
    const hash = pub.build.manifest.hash;
    reply.header('ETag', `"${hash}"`);
    if (v === hash) reply.header('Cache-Control', `${pub.topic.demo ? 'public' : 'private'}, max-age=31536000, immutable`);
    else reply.header('Cache-Control', 'private, no-cache');
    return pub.build.pkg;
  });

  route(app, deps, 'search', async ({ query, lang, reply }) => {
    const l = query.lang ?? lang;
    reply.header('Content-Language', l).header('Cache-Control', 'public, max-age=30');
    return { items: await content.search(query.q, l, query.kind, query.limit ?? 20) };
  });
}
