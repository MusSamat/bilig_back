/** Me (TZ §9): profile, roles, permissions, sessions, 2FA, the student's assignments. */
import type { FastifyInstance } from 'fastify';
import { grantedPermissions } from '@bilig/permissions';
import { t } from '@bilig/content-model';
import { type MeResponse, type MyLicense } from '@bilig/content-model/api';
import type { Deps } from '../deps.js';
import { route } from '../http/route.js';
import { fail } from '../http/errors.js';
import { toRoleGrant } from '../http/auth-context.js';
import { newTotpSecret, otpauthUrl, verifyTotp } from '../domain/totp.js';
import type { UserRec } from '../repo/types.js';
import { assignmentStatus } from './classes.js';
import { cleanTeaching, selfTrial, userSchoolIds } from '../services/teacher-signup.js';
import { principalGrants } from '../services/staff.js';
import { teacherProfile } from '../services/profile.js';
import type { AuthCtx } from '../http/auth-context.js';

export function registerMe(app: FastifyInstance, deps: Deps) {
  const { repo, clock, audit } = deps;

  async function me(user: UserRec, auth?: AuthCtx): Promise<MeResponse> {
    const { grants: rows, roleGrants } = await principalGrants(repo, user.id);
    const totp = await repo.getCredential(user.id, 'totp');
    const profile = await teacherProfile(repo, user, rows);
    const sp = auth?.support;
    return {
      id: user.id,
      kind: user.kind,
      displayName: user.displayName,
      ...(user.email ? { email: user.email } : {}),
      locale: user.locale,
      grants: rows.map(toRoleGrant),
      permissions: grantedPermissions({ userId: user.id, grants: roleGrants }),
      totpEnabled: !!totp && !totp.secretHash.startsWith('pending:'),
      ...(user.phone ? { phone: user.phone } : {}),
      ...(user.teachingLang ? { teachingLang: user.teachingLang } : {}),
      ...(await teachingOf(user)),
      // v0.8.0: the setup checklist and status of every teacher (self-registered and school teachers).
      ...(profile ? { setup: profile.setup, profileStatus: profile.profileStatus } : {}),
      // v0.8.0: the banner while a staff member works in this cabinet.
      ...(sp
        ? { support: { sessionId: sp.session.id, mode: sp.session.mode, actor: { id: sp.actor.id, displayName: sp.actor.displayName }, expiresAt: sp.session.expiresAt.toISOString() } }
        : {}),
    };
  }

  /** v0.6.0: `teaching` (self-registered teachers) and `licenses` (active licences of the user's schools). */
  async function teachingOf(user: UserRec): Promise<Pick<MeResponse, 'teaching' | 'licenses'>> {
    if (user.kind !== 'adult') return {};
    const schoolIds = await userSchoolIds(repo, user.id);
    if (!schoolIds.length) return {};
    const now = clock.now();
    const schools = new Map((await repo.listSchools({ ids: schoolIds }, { limit: 100 })).items.map((s) => [s.id, s]));
    const licenses: MyLicense[] = (await repo.listLicenses({ schoolIds }, { limit: 1000 })).items
      .filter((l) => l.startsAt <= now && now < l.endsAt && schools.has(l.schoolId))
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || (a.id < b.id ? -1 : 1))
      .map((l) => ({
        schoolId: l.schoolId,
        schoolName: schools.get(l.schoolId)!.name,
        subjects: l.subjects,
        grades: l.grades,
        startsAt: l.startsAt.toISOString(),
        endsAt: l.endsAt.toISOString(),
        trial: schools.get(l.schoolId)!.origin === 'self',
      }));
    const self = await selfTrial(repo, user.id);
    const lic = self?.license;
    return {
      ...(lic && lic.subjects.length && lic.grades.length ? { teaching: { subjects: lic.subjects, grades: lic.grades } } : {}),
      licenses,
    };
  }

  route(app, deps, 'me', ({ auth }) => me(auth.user!, auth));

  route(app, deps, 'mePatch', async ({ auth, body, ip }) => {
    const { teaching, schoolName, region, ...profile } = body;
    const uid = auth.user!.id;
    const editsSchool = schoolName !== undefined || region !== undefined;
    // Validate everything first, then write (no half-applied PATCH).
    const self = editsSchool || teaching ? await selfTrial(repo, uid) : null;
    // v0.7.0: a self-registered teacher names their own (self) school; any other school is the admins'.
    if (editsSchool && !self) fail('forbidden', { detail: 'school_not_editable' });
    // v0.6.0: only a self-registered teacher edits the trial licence of their personal school.
    if (teaching && !self?.license) fail('forbidden', { detail: 'teaching_not_editable' });
    const clean = teaching ? await cleanTeaching(repo, teaching) : null;
    if (clean && !clean.subjects.length) fail('validation_failed', { issues: [{ path: ['teaching', 'subjects'], message: 'None of the subjects exists (or is live)' }] });

    if (editsSchool) {
      const school = self!.school;
      const patch = { ...(schoolName !== undefined ? { name: schoolName } : {}), ...(region !== undefined ? { region } : {}) };
      await repo.updateSchool(school.id, patch);
      await audit.log(uid, 'school.updated', { type: 'school', id: school.id }, { ip, diff: { via: 'me', before: { name: school.name, region: school.region }, after: patch } });
    }
    if (clean) {
      const lic = self!.license!;
      await repo.updateLicense(lic.id, { subjects: clean.subjects, grades: clean.grades });
      await audit.log(uid, 'license.updated', { type: 'license', id: lic.id }, { ip, diff: { via: 'me.teaching', before: { subjects: lic.subjects, grades: lic.grades }, after: clean } });
    }
    const before = auth.user!;
    const u = Object.keys(profile).length ? await repo.updateUser(uid, profile) : await repo.getUser(uid);
    if (Object.keys(profile).length) {
      const keys = Object.keys(profile) as (keyof typeof profile)[];
      await audit.log(uid, 'profile.updated', { type: 'user', id: uid }, {
        ip,
        before: Object.fromEntries(keys.map((k) => [k, (before as unknown as Record<string, unknown>)[k] ?? null])),
        after: profile,
      });
    }
    return me(u!, auth);
  });

  route(app, deps, 'meSessions', async ({ auth }) => {
    const items = await repo.listActiveSessions(auth.user!.id, clock.now());
    return {
      items: items.map((s) => ({
        id: s.id,
        device: s.device,
        ...(s.ip ? { ip: s.ip } : {}),
        createdAt: s.createdAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        current: s.family === auth.session?.family,
      })),
    };
  });

  route(app, deps, 'meSessionRevoke', async ({ auth, params }) => {
    const s = await repo.getSession(params.id);
    if (!s || s.userId !== auth.user!.id) fail('not_found');
    await repo.revokeFamily(s.family, clock.now());
    return { ok: true as const };
  });

  // POST /me/2fa: setup → verify (enables) → disable (needs a valid code)
  route(app, deps, 'me2fa', async ({ auth, body, ip }) => {
    const user = auth.user!;
    if (user.kind !== 'adult' || !user.email) fail('forbidden');
    const cur = await repo.getCredential(user.id, 'totp');
    const active = cur && !cur.secretHash.startsWith('pending:') ? cur.secretHash : null;
    const now = clock.now();
    switch (body.action) {
      case 'setup': {
        if (active) fail('conflict', { detail: 'totp_already_enabled' });
        const secret = newTotpSecret();
        await repo.setCredential(user.id, 'totp', `pending:${secret}`);
        return { enabled: false, otpauthUrl: otpauthUrl(secret, user.email!) };
      }
      case 'verify': {
        if (!cur || active) fail('conflict', { detail: 'totp_not_pending' });
        const secret = cur!.secretHash.slice('pending:'.length);
        if (!verifyTotp(secret, body.code, now)) fail('invalid_credentials');
        await repo.setCredential(user.id, 'totp', secret);
        await audit.log(user.id, 'auth.2fa_enabled', { type: 'user', id: user.id }, { ip });
        return { enabled: true };
      }
      case 'disable': {
        if (!active) fail('conflict', { detail: 'totp_not_enabled' });
        if (!verifyTotp(active!, body.code, now)) fail('invalid_credentials');
        await repo.deleteCredential(user.id, 'totp');
        await audit.log(user.id, 'auth.2fa_disabled', { type: 'user', id: user.id }, { ip });
        return { enabled: false };
      }
    }
  });

  // GET /me/assignments — student cabinet (W-54)
  route(app, deps, 'meAssignments', async ({ auth, lang }) => {
    const uid = auth.user!.id;
    const enr = await repo.listEnrollments({ userId: uid, role: 'student' });
    if (!enr.length) return { items: [] };
    const classes = (await repo.listClasses({ ids: enr.map((e) => e.classId) }, { limit: 100 })).items;
    const names = new Map(classes.map((c) => [c.id, c.name]));
    const list = (await repo.listAssignments({ classIds: classes.map((c) => c.id) }, { limit: 100 })).items;
    const attempts = await repo.listAttempts({ userId: uid });
    // v0.3.0: topic info from the published package (title in the request language).
    const topics = new Map<string, { topicTitle: string; subjectKey: string; unitKey: string; grade?: number }>();
    for (const key of new Set(list.map((a) => a.topicKey))) {
      const pub = await deps.content.getPublished(key);
      if (pub) {
        const pkg = pub.build.pkg;
        topics.set(key, { topicTitle: t(pkg.topic.title, lang), subjectKey: pkg.subject.key, unitKey: pkg.topic.unitKey, ...(pkg.course ? { grade: pkg.course.grade } : {}) });
      }
    }
    return {
      items: list.map((a) => {
        const st = assignmentStatus(attempts.filter((x) => x.assignmentId === a.id));
        return {
          id: a.id,
          classId: a.classId,
          className: names.get(a.classId) ?? '',
          topicKey: a.topicKey,
          activities: a.activities as ('tour' | 'quiz' | 'process' | 'comparison')[],
          ...(a.dueAt ? { dueAt: a.dueAt.toISOString() } : {}),
          createdBy: a.createdBy,
          createdAt: a.createdAt.toISOString(),
          status: st.status,
          ...(st.score !== undefined ? { score: st.score } : {}),
          ...(topics.get(a.topicKey) ?? {}),
        };
      }),
    };
  });
}
