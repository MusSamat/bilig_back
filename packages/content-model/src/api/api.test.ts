import { describe, it, expect } from 'vitest';
import { grantedPermissions, type Principal } from '@bilig/permissions';
import {
  ENDPOINTS,
  ProblemSchema,
  ClassCodeRequestSchema,
  MeResponseSchema,
  SyncRequestSchema,
  SyncResponseSchema,
  TutorAskRequestSchema,
  TutorStreamEventSchema,
  SnapshotCreateRequestSchema,
  SlideSchema,
  LicenseSchema,
  ProgressSchema,
  StudentsAddRequestSchema,
  AdminConceptPatchSchema,
  CatalogResponseSchema,
  TopicManifestResponseSchema,
  availableActions,
  buildPath,
  collectTutorStream,
  cursorPage,
  encodeSseEvent,
  parseSseEvents,
  problem,
  routePath,
  transition,
  WORKFLOW,
  type TutorStreamEvent,
} from './index.js';
import { z } from 'zod';
import { ContentPackageSchema, ItemSchema } from '../index.js';
import { animalCellCatalog, animalCellPackage } from '../fixtures/animal-cell.js';

const UUID = '01929f3c-7d2a-7cc1-9a51-2c9f3e7b1a00';
const NOW = '2026-10-15T09:00:00Z';

describe('problem+json', () => {
  it('builds a valid RFC 9457 body with code and i18nKey', () => {
    const p = problem('forbidden', { detail: 'nope' });
    expect(ProblemSchema.parse(p)).toEqual({
      type: 'https://bilig.kg/problems/forbidden',
      title: 'forbidden',
      status: 403,
      code: 'forbidden',
      i18nKey: 'errors.forbidden',
      detail: 'nope',
    });
    expect(problem('tutor_unavailable').status).toBe(503);
    expect(problem('not_found', { status: 410 }).status).toBe(410);
    expect(ProblemSchema.safeParse({ ...p, code: 'weird' }).success).toBe(false);
  });
});

describe('cursor pagination', () => {
  it('wraps items with nextCursor (nullable)', () => {
    const Page = cursorPage(z.object({ id: z.string() }));
    expect(Page.safeParse({ items: [{ id: 'a' }], nextCursor: null }).success).toBe(true);
    expect(Page.safeParse({ items: [], nextCursor: 'c2' }).success).toBe(true);
    expect(Page.safeParse({ items: [] }).success).toBe(false);
  });
});

describe('auth & me', () => {
  it('class codes are normalized to upper case and must be 6 chars', () => {
    expect(ClassCodeRequestSchema.parse({ code: ' ab12cd ' }).code).toBe('AB12CD');
    expect(ClassCodeRequestSchema.safeParse({ code: 'AB12' }).success).toBe(false);
  });

  it('/me carries the grantedPermissions list from @bilig/permissions', () => {
    const principal: Principal = {
      userId: UUID,
      grants: [{ role: 'author', scope: 'subject', scopeId: 'bio', subrole: 'translator' }],
    };
    const me = MeResponseSchema.parse({
      id: UUID,
      kind: 'adult',
      displayName: 'Айгүл',
      locale: 'ky',
      grants: principal.grants,
      permissions: grantedPermissions(principal),
    });
    expect(me.permissions).toContain('content.draft.edit');
    expect(MeResponseSchema.safeParse({ ...me, permissions: ['root.everything'] }).success).toBe(false);
    expect(MeResponseSchema.safeParse({ ...me, grants: [{ role: 'author', scope: 'subject', subrole: 'poet' }] }).success).toBe(false);
  });
});

describe('catalog', () => {
  it('catalog and manifest responses accept fixture data', () => {
    expect(CatalogResponseSchema.safeParse(animalCellCatalog).success).toBe(true);
    expect(
      TopicManifestResponseSchema.safeParse({
        manifest: animalCellPackage.manifest,
        packageUrl: `/cdn/${animalCellPackage.manifest.hash}/package.json`,
        filesBaseUrl: `/cdn/${animalCellPackage.manifest.hash}/`,
      }).success,
    ).toBe(true);
    expect(ContentPackageSchema.safeParse(animalCellPackage).success).toBe(true);
  });
});

describe('learning & offline sync', () => {
  const attempt = {
    clientId: UUID,
    topicKey: 'animal-cell',
    topicVersion: '1.0.0',
    seed: 'seed-1',
    itemKeys: ['bio.q.powerhouse'],
    startedAt: NOW,
    answers: [
      { itemKey: 'bio.q.powerhouse', response: { type: 'single', value: 'b' }, timeMs: 1200, answeredAt: NOW },
    ],
  };

  it('accepts a sync batch with attempts, progress and events', () => {
    const req = SyncRequestSchema.parse({
      attempts: [attempt],
      progress: [{ topicKey: 'animal-cell', visitedConcepts: ['bio.nucleus'], completedActivities: ['tour', 'process:bio.respiration'], updatedAt: NOW }],
      events: [{ id: UUID, verb: 'selected', object: { type: 'concept', key: 'bio.nucleus' }, ts: NOW }],
    });
    expect(req.attempts[0].answers[0].response.type).toBe('single');
    expect(SyncResponseSchema.safeParse({
      attempts: [{ clientId: UUID, status: 'duplicate', id: UUID }],
      progress: [],
      events: { accepted: 0, duplicates: 1 },
    }).success).toBe(true);
  });

  it('rejects client ids that are not UUIDs and bad activity keys', () => {
    expect(SyncRequestSchema.safeParse({ attempts: [{ ...attempt, clientId: 'x' }], progress: [], events: [] }).success).toBe(false);
    expect(ProgressSchema.safeParse({ topicKey: 'a', visitedConcepts: [], completedActivities: ['dance'], updatedAt: NOW }).success).toBe(false);
  });

  it('POST /sync is declared idempotent', () => {
    expect(ENDPOINTS.sync.idempotent).toBe(true);
  });
});

describe('classes', () => {
  it('students can be added as a list or CSV', () => {
    expect(StudentsAddRequestSchema.safeParse({ students: [{ displayName: 'Бакыт' }] }).success).toBe(true);
    expect(StudentsAddRequestSchema.safeParse({ csv: 'Бакыт\nАйпери' }).success).toBe(true);
    expect(StudentsAddRequestSchema.safeParse({ students: [] }).success).toBe(false);
  });
});

describe('tutor SSE', () => {
  const events: TutorStreamEvent[] = [
    { type: 'token', text: 'Ядро ' },
    { type: 'citation', conceptKey: 'bio.nucleus', label: 'Ядро' },
    { type: 'token', text: 'хранит ДНК.' },
    { type: 'citation', conceptKey: 'bio.nucleus' },
    { type: 'done', threadId: UUID },
  ];

  it('encode → parse round-trips, across arbitrary chunk boundaries', () => {
    const wire = events.map(encodeSseEvent).join('');
    expect(parseSseEvents(wire)).toEqual({ events, rest: '' });
    let buf = '';
    const got: TutorStreamEvent[] = [];
    for (let i = 0; i < wire.length; i += 7) {
      const r = parseSseEvents(buf + wire.slice(i, i + 7));
      got.push(...r.events);
      buf = r.rest;
    }
    expect(got).toEqual(events);
  });

  it('skips malformed frames and handles CRLF', () => {
    const wire = 'data: {bad json}\n\nevent: x\n\ndata: {"type":"nope"}\n\r\ndata: {"type":"token","text":"a"}\r\n\r\n';
    expect(parseSseEvents(wire).events).toEqual([{ type: 'token', text: 'a' }]);
  });

  it('collectTutorStream folds tokens and de-duplicates citations', () => {
    expect(collectTutorStream(events)).toEqual({ answer: 'Ядро хранит ДНК.', citations: ['bio.nucleus'], threadId: UUID });
    expect(collectTutorStream([{ type: 'error', code: 'x', i18nKey: 'y' }])).toEqual({ answer: '', citations: [] });
  });

  it('validates the ask request and event union', () => {
    expect(TutorAskRequestSchema.safeParse({ topicKey: 'animal-cell', question: '  ', lang: 'ru' }).success).toBe(false);
    expect(TutorAskRequestSchema.safeParse({ topicKey: 'animal-cell', question: 'Что такое ядро?', lang: 'ky', conceptKey: 'bio.nucleus' }).success).toBe(true);
    expect(TutorStreamEventSchema.safeParse({ type: 'error', code: 'rate_limited', i18nKey: 'errors.rate_limited' }).success).toBe(true);
  });
});

describe('decks & snapshots', () => {
  it('snapshot keeps image + scene state; slides are a discriminated union', () => {
    expect(
      SnapshotCreateRequestSchema.safeParse({
        topicKey: 'animal-cell',
        topicVersion: '1.0.0',
        image: 'data:image/webp;base64,AAAA',
        sceneState: { lang: 'ky', subjectKey: 'bio', grade: 'g7', topicKey: 'animal-cell', focus: 'bio.nucleus' },
      }).success,
    ).toBe(true);
    expect(SnapshotCreateRequestSchema.safeParse({ topicKey: 'a', topicVersion: '1.0.0', image: 'http://x', sceneState: {} }).success).toBe(false);
    expect(SlideSchema.safeParse({ id: 's1', kind: 'process', processKey: 'bio.respiration', title: 'Дыхание', steps: ['a'] }).success).toBe(true);
    expect(SlideSchema.safeParse({ id: 's1', kind: 'video' }).success).toBe(false);
  });
});

describe('admin: publish workflow (A-13)', () => {
  it('draft → review → published → archived, with reject/rollback/restore', () => {
    expect(transition('draft', 'submit')).toBe('review');
    expect(transition('review', 'reject')).toBe('draft');
    expect(transition('review', 'approve')).toBe('published');
    expect(transition('review', 'publish')).toBe('published');
    expect(transition('published', 'archive')).toBe('archived');
    expect(transition('archived', 'rollback')).toBe('published');
    expect(transition('archived', 'restore')).toBe('draft');
    expect(transition('draft', 'publish')).toBeNull();
    expect(transition('published', 'submit')).toBeNull();
  });

  it('available actions per state; only submit is an author action', () => {
    expect(availableActions('draft')).toEqual(['submit']);
    expect(availableActions('review')).toEqual(['reject', 'approve', 'publish']);
    expect(Object.entries(WORKFLOW).filter(([, r]) => r.permission === 'content.draft.edit').map(([a]) => a)).toEqual(['submit']);
  });

  it('patch payloads are partial and require an optimistic version', () => {
    expect(AdminConceptPatchSchema.safeParse({ hue: 10, version: 3 }).success).toBe(true);
    expect(AdminConceptPatchSchema.safeParse({ hue: 10 }).success).toBe(false);
  });

  it('licence end must be after start', () => {
    const lic = { id: UUID, schoolId: UUID, subjects: ['bio'], grades: [7], seats: 30, startsAt: '2026-09-01T00:00:00Z', endsAt: '2027-06-01T00:00:00Z' };
    expect(LicenseSchema.safeParse(lic).success).toBe(true);
    expect(LicenseSchema.safeParse({ ...lic, endsAt: '2026-01-01T00:00:00Z' }).success).toBe(false);
  });

  it('admin item create uses the item bank schema', () => {
    expect(ENDPOINTS.adminItemCreate.body).toBe(ItemSchema);
  });
});

describe('endpoint table', () => {
  it('builds paths with encoded params and fails on missing ones', () => {
    expect(buildPath(ENDPOINTS.topicManifest.path, { key: 'animal-cell' })).toBe('/topics/animal-cell/manifest');
    expect(buildPath('/a/:id/b/:x', { id: 'a b', x: '1' })).toBe('/a/a%20b/b/1');
    expect(() => buildPath('/a/:id')).toThrow(/id/);
    expect(routePath('health')).toBe('/api/v1/health');
  });

  it('every endpoint has a unique method+path, and a response schema', () => {
    const seen = new Set<string>();
    for (const [name, def] of Object.entries(ENDPOINTS)) {
      const id = `${def.method} ${def.path}`;
      expect(seen.has(id), `${name}: ${id}`).toBe(false);
      seen.add(id);
      expect(def.response, name).toBeDefined();
      expect(def.path.startsWith('/')).toBe(true);
    }
  });

  it('covers the TZ §9 modules', () => {
    const paths = Object.values(ENDPOINTS).map((d) => d.path);
    for (const p of [
      '/auth/login', '/auth/class-code', '/auth/student-login', '/auth/refresh', '/auth/logout',
      '/me', '/subjects', '/subjects/:key/courses', '/courses/:key', '/topics/:key/manifest', '/search',
      '/progress/:topicKey', '/attempts', '/attempts/:id/answers', '/attempts/:id/finish', '/sync', '/events',
      '/classes', '/classes/:id/students', '/classes/:id/assignments', '/assignments/:id/results',
      '/tutor/ask', '/presentations', '/snapshots', '/admin/subjects', '/admin/concepts', '/admin/topics',
      '/admin/topics/:id/versions', '/admin/topics/:id/publish',
    ]) {
      expect(paths, p).toContain(p);
    }
  });
});
