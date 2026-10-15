/** Me (TZ §9): profile, roles, permissions, sessions, 2FA, the student's assignments. */
import type { FastifyInstance } from 'fastify';
import { grantedPermissions } from '@bilig/permissions';
import { t } from '@bilig/content-model';
import type { MeResponse } from '@bilig/content-model/api';
import type { Deps } from '../deps.js';
import { route } from '../http/route.js';
import { fail } from '../http/errors.js';
import { toRoleGrant } from '../http/auth-context.js';
import { newTotpSecret, otpauthUrl, verifyTotp } from '../domain/totp.js';
import type { UserRec } from '../repo/types.js';
import { assignmentStatus } from './classes.js';

export function registerMe(app: FastifyInstance, deps: Deps) {
  const { repo, clock, audit } = deps;

  async function me(user: UserRec): Promise<MeResponse> {
    const grants = (await repo.listGrants(user.id)).map(toRoleGrant);
    const totp = await repo.getCredential(user.id, 'totp');
    return {
      id: user.id,
      kind: user.kind,
      displayName: user.displayName,
      ...(user.email ? { email: user.email } : {}),
      locale: user.locale,
      grants,
      permissions: grantedPermissions({ userId: user.id, grants }),
      totpEnabled: !!totp && !totp.secretHash.startsWith('pending:'),
    };
  }

  route(app, deps, 'me', ({ auth }) => me(auth.user!));

  route(app, deps, 'mePatch', async ({ auth, body }) => {
    const u = await repo.updateUser(auth.user!.id, body);
    return me(u!);
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
