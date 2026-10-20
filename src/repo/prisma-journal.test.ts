/**
 * Contract 0.8.0 journal on PostgreSQL (`npm run test:db`): the append-only
 * trigger, tamper detection by the chain verify, monthly partitions and
 * retention, the read-only legacy AuditLog, and the 0.8.0 migration (author /
 * editor → manager, AuditLog → AuditEvent in time order) on a scratch database.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { newId } from '../ids.js';
import { PrismaRepository } from './prisma.js';
import type { AuditEventInput } from './types.js';

const url = process.env.TEST_DATABASE_URL;

const ev = (patch: Partial<AuditEventInput> = {}): AuditEventInput => ({
  id: newId(),
  at: new Date(),
  actorId: null,
  actorRole: null,
  onBehalfOfId: null,
  group: 'auth',
  action: 'auth.login',
  targetType: 'user',
  targetId: 'u1',
  targetLabel: null,
  before: null,
  after: { a: 1 },
  details: null,
  reason: null,
  result: 'ok',
  ip: null,
  userAgent: null,
  requestId: null,
  supportSessionId: null,
  ...patch,
});

if (!url) {
  describe.skip('journal on PostgreSQL (set TEST_DATABASE_URL, see `npm run test:db`)', () => {
    it('skipped', () => {});
  });
} else {
  const db = new PrismaClient({ datasources: { db: { url } } });
  const repo = new PrismaRepository(db);
  afterAll(() => db.$disconnect());

  describe('journal on PostgreSQL', () => {
    beforeEach(async () => {
      await db.$executeRawUnsafe('TRUNCATE "AuditEvent", "AuditAlert"');
    });

    it('is append-only: UPDATE and DELETE are rejected by the trigger', async () => {
      const e = await repo.appendJournal(ev());
      await expect(db.$executeRaw`UPDATE "AuditEvent" SET "targetId" = 'x' WHERE "seq" = ${e.seq}`).rejects.toThrow(/append-only/);
      await expect(db.$executeRaw`DELETE FROM "AuditEvent" WHERE "seq" = ${e.seq}`).rejects.toThrow(/append-only/);
      await expect(db.auditEvent.updateMany({ data: { reason: 'x' } })).rejects.toThrow();
      expect((await repo.listJournal({}, { limit: 5 })).items[0]).toMatchObject({ targetId: 'u1', reason: null });
    });

    it('the chain verify detects tampering (trigger disabled only to tamper)', async () => {
      for (let i = 0; i < 4; i++) await repo.appendJournal(ev({ targetId: `t${i}`, details: { n: i, nested: { 'ключ': 1 } } }));
      expect(await repo.verifyJournal()).toEqual({ ok: true, checked: 4, brokenAt: null });
      await db.$transaction([
        db.$executeRawUnsafe('ALTER TABLE "AuditEvent" DISABLE TRIGGER audit_event_immutable'),
        db.$executeRawUnsafe(`UPDATE "AuditEvent" SET "after" = '{"a": 2}' WHERE "seq" = 3`),
        db.$executeRawUnsafe('ALTER TABLE "AuditEvent" ENABLE TRIGGER audit_event_immutable'),
      ]);
      expect(await repo.verifyJournal()).toEqual({ ok: false, checked: 3, brokenAt: 3 });
      // the trigger is back
      await expect(db.$executeRaw`UPDATE "AuditEvent" SET "targetId" = 'y' WHERE "seq" = 1`).rejects.toThrow(/append-only/);
    });

    it('a removed row in the middle breaks the chain (seq gap / prevHash)', async () => {
      for (let i = 0; i < 3; i++) await repo.appendJournal(ev({ targetId: `g${i}` }));
      await db.$transaction([
        db.$executeRawUnsafe('ALTER TABLE "AuditEvent" DISABLE TRIGGER audit_event_immutable'),
        db.$executeRawUnsafe('DELETE FROM "AuditEvent" WHERE "seq" = 2'),
        db.$executeRawUnsafe('ALTER TABLE "AuditEvent" ENABLE TRIGGER audit_event_immutable'),
      ]);
      expect(await repo.verifyJournal()).toEqual({ ok: false, checked: 2, brokenAt: 3 });
    });

    it('monthly partitions ahead; retention drops partitions older than 36 months (DDL); the chain anchors on the first kept row', async () => {
      const r = await repo.maintainJournal(new Date('2031-01-15T00:00:00Z'), 2, 36);
      expect(r.created).toBe(3);
      const parts = async () =>
        (await db.$queryRaw<{ relname: string }[]>`SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = '"AuditEvent"'::regclass`).map((x) => x.relname);
      expect(await parts()).toEqual(expect.arrayContaining(['AuditEvent_default', 'AuditEvent_p203101', 'AuditEvent_p203102', 'AuditEvent_p203103']));
      // an old month with an event, then a newer one
      await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "AuditEvent_p202701" PARTITION OF "AuditEvent" FOR VALUES FROM ('2027-01-01T00:00:00Z') TO ('2027-02-01T00:00:00Z')`);
      await repo.appendJournal(ev({ at: new Date('2027-01-10T00:00:00Z'), targetId: 'old' }));
      await repo.appendJournal(ev({ at: new Date('2031-01-20T00:00:00Z'), targetId: 'new' }));
      expect((await db.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM "AuditEvent_p202701"`)[0].n).toBe(1n);
      const d = await repo.maintainJournal(new Date('2030-02-15T00:00:00Z'), 0, 36);
      expect(d.dropped).toBe(1);
      expect(await parts()).not.toContain('AuditEvent_p202701');
      expect((await repo.listJournal({}, { limit: 5 })).items.map((e) => e.targetId)).toEqual(['new']);
      expect(await repo.verifyJournal()).toEqual({ ok: true, checked: 1, brokenAt: null });
      for (const p of (await parts()).filter((x) => /^AuditEvent_p203/.test(x))) await db.$executeRawUnsafe(`DROP TABLE "${p}"`);
    });

    it('the legacy AuditLog is read only', async () => {
      await expect(db.$executeRaw`INSERT INTO "AuditLog" ("id", "action", "targetType", "targetId", "ts") VALUES (${newId()}::uuid, 'x', 'y', 'z', now())`).rejects.toThrow(/read only/);
    });
  });

  describe('migration 0.8.0 on a scratch database', () => {
    it('author / editor → manager with mapped permissions; AuditLog → AuditEvent in time order, chained', async () => {
      const name = `bilig_migr_${Date.now()}`;
      const scratch = url.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
      await db.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
      const dir = mkdtempSync(join(tmpdir(), 'bilig-migr-'));
      const s = new PrismaClient({ datasources: { db: { url: scratch } } });
      try {
        cpSync('prisma/schema.prisma', join(dir, 'schema.prisma'));
        const all = readdirSync('prisma/migrations').filter((d) => !d.endsWith('.toml')).sort();
        const target = all.find((d) => d.endsWith('contract_0_8_0'))!;
        cpSync('prisma/migrations/migration_lock.toml', join(dir, 'migrations', 'migration_lock.toml'), { recursive: true });
        for (const m of all.filter((d) => d < target)) cpSync(join('prisma/migrations', m), join(dir, 'migrations', m), { recursive: true });
        const deploy = () => {
          const r = spawnSync('npx', ['prisma', 'migrate', 'deploy', '--schema', join(dir, 'schema.prisma')], { env: { ...process.env, DATABASE_URL: scratch }, encoding: 'utf8' });
          if (r.status !== 0) throw new Error(r.stderr || r.stdout);
        };
        deploy();

        const [author, editor, sa, teacher] = [newId(), newId(), newId(), newId()];
        for (const [id, email] of [[author, 'a@x.kg'], [editor, 'e@x.kg'], [sa, 's@x.kg'], [teacher, 't@x.kg']]) {
          await s.$executeRawUnsafe(`INSERT INTO "User" (id, kind, email, "displayName", locale, status, "createdAt", "updatedAt") VALUES ('${id}', 'adult', '${email}', 'N', 'ru', 'active', now(), now())`);
        }
        const grant = (u: string, role: string, scopeType: string, scopeId: string) =>
          s.$executeRawUnsafe(`INSERT INTO "RoleAssignment" (id, "userId", role, "scopeType", "scopeId") VALUES ('${newId()}', '${u}', '${role}', '${scopeType}', '${scopeId}')`);
        await grant(author, 'author', 'subject', 'bio');
        await grant(author, 'author', 'subject', 'chem');
        await grant(editor, 'editor', 'subject', 'bio');
        await grant(editor, 'author', 'subject', 'phys');
        await grant(sa, 'superadmin', 'platform', '');
        await grant(teacher, 'teacher', 'school', newId());
        await s.$executeRawUnsafe(`INSERT INTO "Invite" (id, email, role, "scopeType", "scopeId", "tokenHash", "invitedBy", "createdAt", "expiresAt") VALUES ('${newId()}', 'p@x.kg', 'editor', 'subject', 'bio', 'h1', '${sa}', now(), now() + interval '1 day')`);
        await s.$executeRawUnsafe(`INSERT INTO "School" (id, name, region, type, language, status, "createdAt") VALUES ('${newId()}', 'S', 'R', 'state', 'ky', 'active', now())`);
        const logs: [string, string, string | null, string][] = [
          [newId(), '2026-03-05T10:00:00.123Z', 'auth.login_failed', '{"reason":"totp"}'],
          [newId(), '2025-12-31T23:59:59.000Z', 'content.publish', '{"before":{"v":1},"after":{"v":2}}'],
          [newId(), '2026-10-01T00:00:00.000Z', 'user.grants_changed', 'null'],
        ];
        for (const [id, ts, action, diff] of logs) {
          await s.$executeRawUnsafe(`INSERT INTO "AuditLog" (id, "actorId", action, "targetType", "targetId", diff, ip, ts) VALUES ('${id}', '${sa}', '${action}', 'user', 'x', ${diff === 'null' ? 'NULL' : `'${diff}'::jsonb`}, '1.2.3.4', '${ts}')`);
        }

        cpSync(join('prisma/migrations', target), join(dir, 'migrations', target), { recursive: true });
        deploy();

        const roles = await s.$queryRawUnsafe<{ userId: string; role: string; scopeType: string }[]>(`SELECT "userId", role, "scopeType" FROM "RoleAssignment" ORDER BY role`);
        expect(roles.filter((r) => r.role === 'author' || r.role === 'editor')).toEqual([]);
        expect(roles.filter((r) => r.role === 'manager').map((r) => r.userId).sort()).toEqual([author, editor].sort());
        expect(roles.find((r) => r.userId === teacher)?.role).toBe('teacher');
        const profiles = new Map((await s.$queryRawUnsafe<{ userId: string; permissions: string[] }[]>(`SELECT "userId", permissions FROM "StaffProfile"`)).map((p) => [p.userId, p.permissions]));
        expect(profiles.get(author)?.sort()).toEqual(['content.draft.edit', 'model.upload']);
        expect(profiles.get(editor)?.sort()).toEqual(['content.draft.edit', 'content.publish', 'content.review', 'model.upload']);
        expect(profiles.get(sa)).toEqual([]);
        expect(profiles.has(teacher)).toBe(false);
        const inv = (await s.$queryRawUnsafe<{ role: string; scopeType: string; permissions: string[] }[]>(`SELECT role, "scopeType", permissions FROM "Invite"`))[0];
        expect(inv).toMatchObject({ role: 'manager', scopeType: 'platform' });
        expect(inv.permissions).toContain('content.publish');

        const events = await s.$queryRawUnsafe<{ seq: bigint; id: string; action: string; group: string; result: string; before: unknown; after: unknown; details: unknown; at: Date }[]>(
          `SELECT seq, id, action, "group", result, before, after, details, at FROM "AuditEvent" ORDER BY seq`,
        );
        expect(events.map((e) => e.action)).toEqual(['content.publish', 'auth.login_failed', 'user.grants_changed']);
        expect(events.map((e) => e.id)).toEqual([logs[1][0], logs[0][0], logs[2][0]]);
        expect(events.map((e) => Number(e.seq))).toEqual([1, 2, 3]);
        expect(events[0]).toMatchObject({ group: 'content', result: 'ok', before: { v: 1 }, after: { v: 2 } });
        expect(events[1]).toMatchObject({ group: 'auth', result: 'failed', details: { reason: 'totp' } });
        expect(events[1].at.toISOString()).toBe('2026-03-05T10:00:00.123Z');
        expect(events[2]).toMatchObject({ group: 'staff', details: null });
        const [v] = await s.$queryRawUnsafe<{ ok: boolean; checked: bigint }[]>(`SELECT * FROM audit_event_verify()`);
        expect(v).toMatchObject({ ok: true, checked: 3n });
        const verifyRepo = new PrismaRepository(s);
        expect((await verifyRepo.listAudit({}, { limit: 10 })).items.map((a) => a.action).sort()).toEqual(['auth.login_failed', 'content.publish', 'user.grants_changed']);
        await expect(s.$executeRawUnsafe(`INSERT INTO "AuditLog" (id, action, "targetType", "targetId", ts) VALUES ('${newId()}', 'x', 'y', 'z', now())`)).rejects.toThrow(/read only/);
        // existing classes keep their subject as the first of subjectKeys (none here, the column exists)
        expect((await s.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM information_schema.columns WHERE table_name = 'Class' AND column_name = 'subjectKeys'`))[0].n).toBe(1n);
      } finally {
        await s.$disconnect();
        rmSync(dir, { recursive: true, force: true });
        await db.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      }
    }, 120_000);
  });
}
