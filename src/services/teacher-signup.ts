/**
 * Contract 0.6.0 — teachers register themselves. What e-mail confirmation
 * provisions (a personal `origin: self` school, a teacher grant on it and a
 * trial licence for the subjects × grades they teach), the registration mails
 * in the user's language, and the lookups behind GET/PATCH /me `teaching`.
 * Shared by the 6-digit code (POST /auth/register/verify) and the v0.2.1 link
 * (POST /auth/email/verify).
 */
import type { Lang } from '@bilig/content-model';
import type { Deps } from '../deps.js';
import { newId } from '../ids.js';
import type { LicenseRec, Repository, SchoolRec, SignupRec, UserRec } from '../repo/types.js';

export const TRIAL_SEATS = 40;
/** The school roles that tie an adult to a school. */
const SCHOOL_ROLES = new Set(['teacher', 'school_admin']);

export interface Teaching {
  subjects: string[];
  grades: number[];
}

/** Keys of subjects with `status: live`. */
export async function liveSubjectKeys(repo: Repository): Promise<Set<string>> {
  const keys = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await repo.content('subject').list({}, { cursor, limit: 100 });
    for (const s of page.items) if (s.data.status === 'live') keys.add(s.key);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return keys;
}

/** Subjects filtered to existing live ones, grades to 1..11; deduplicated and sorted. */
export async function cleanTeaching(repo: Repository, t: Teaching | undefined): Promise<Teaching> {
  if (!t) return { subjects: [], grades: [] };
  const live = await liveSubjectKeys(repo);
  return {
    subjects: [...new Set(t.subjects)].filter((k) => live.has(k)).sort(),
    grades: [...new Set(t.grades)].filter((g) => Number.isInteger(g) && g >= 1 && g <= 11).sort((a, b) => a - b),
  };
}

const PERSONAL: Record<Lang, string> = { ky: 'жеке мектеп', ru: 'личная школа', en: 'personal school' };
export const personalSchoolName = (displayName: string, lang: Lang) => `${displayName} — ${PERSONAL[lang] ?? PERSONAL.ky}`.slice(0, 200);

/**
 * v0.7.0: the placeholder name of a phone-registered teacher's school until
 * they name it in the cabinet (GET /me `setup.school` is false while it is one of these).
 */
const PLACEHOLDER_SCHOOL: Record<Lang, string> = { ky: 'Менин мектебим', ru: 'Моя школа', en: 'My school' };
export const placeholderSchoolName = (lang: Lang) => PLACEHOLDER_SCHOOL[lang] ?? PLACEHOLDER_SCHOOL.ky;
export const isPlaceholderSchoolName = (name: string) => Object.values(PLACEHOLDER_SCHOOL).includes(name.trim());

/** School ids the adult is tied to through a teacher / school admin grant. */
export async function userSchoolIds(repo: Repository, userId: string): Promise<string[]> {
  const grants = await repo.listGrants(userId);
  return [...new Set(grants.filter((g) => SCHOOL_ROLES.has(g.role) && g.scope === 'school' && g.scopeId).map((g) => g.scopeId!))];
}

/** A self-registered teacher's personal school and its trial licence (the latest one), if any. */
export async function selfTrial(repo: Repository, userId: string): Promise<{ school: SchoolRec; license: LicenseRec | null } | null> {
  const grants = (await repo.listGrants(userId)).filter((g) => g.role === 'teacher' && g.scope === 'school' && g.scopeId);
  for (const g of grants) {
    const school = await repo.getSchool(g.scopeId!);
    if (school?.origin !== 'self') continue;
    const lic = (await repo.listLicenses({ schoolIds: [school.id] }, { limit: 100 })).items.sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime());
    return { school, license: lic[0] ?? null };
  }
  return null;
}

/**
 * Activates a pending self-registered teacher and creates their workspace.
 * Skips the workspace when the user already belongs to a school (e.g. an
 * invited teacher confirming the e-mail), so repeating it is harmless.
 */
export async function provisionSelfTeacher(
  deps: Deps,
  user: UserRec,
  ip: string | null,
  opts: { method?: 'email' | 'phone'; schoolName?: string } = {},
): Promise<UserRec> {
  const { repo, clock, audit, config } = deps;
  const now = clock.now();
  const signup: SignupRec = user.signup ?? {};
  if (!(await userSchoolIds(repo, user.id)).length) {
    const teaching = await cleanTeaching(repo, signup.teaching);
    const school: SchoolRec = {
      id: newId(),
      name: signup.schoolName?.trim() || opts.schoolName || personalSchoolName(user.displayName, user.locale),
      region: signup.region?.trim() ?? '',
      type: 'private',
      language: user.locale,
      status: 'active',
      origin: 'self',
      createdAt: now,
      version: 1,
    };
    await repo.createSchool(school);
    const license = await repo.createLicense({
      id: newId(),
      schoolId: school.id,
      subjects: teaching.subjects,
      grades: teaching.grades,
      seats: TRIAL_SEATS,
      startsAt: now,
      endsAt: new Date(now.getTime() + config.trialDays * 86400_000),
    });
    await repo.addGrant({ userId: user.id, role: 'teacher', scope: 'school', scopeId: school.id, subrole: null });
    await audit.log(user.id, 'auth.self_registered', { type: 'user', id: user.id }, {
      ip,
      diff: { method: opts.method ?? 'email', schoolId: school.id, licenseId: license === 'conflict' ? null : license.id, subjects: teaching.subjects, grades: teaching.grades, trialDays: config.trialDays },
    });
  }
  const next = await repo.updateUser(user.id, { status: 'active', ...(user.email ? { emailVerifiedAt: user.emailVerifiedAt ?? now } : {}), signup: null });
  return next ?? user;
}

// --- mails (ky / ru / en) --------------------------------------------------------

const CODE_MAIL: Record<Lang, (code: string, minutes: number, link: string) => { subject: string; text: string }> = {
  ky: (code, min, link) => ({
    subject: `Bilig: ырастоо коду ${code}`,
    text: `Bilig'де катталууну ырастоо коду: ${code}\nКод ${min} мүнөт жарактуу.\n\nЖе ушул шилтемени ачыңыз:\n${link}\n\nЭгер сиз катталбасаңыз, бул катты көңүлгө албаңыз.`,
  }),
  ru: (code, min, link) => ({
    subject: `Bilig: код подтверждения ${code}`,
    text: `Код подтверждения регистрации в Bilig: ${code}\nКод действует ${min} минут.\n\nИли откройте ссылку:\n${link}\n\nЕсли вы не регистрировались, просто проигнорируйте это письмо.`,
  }),
  en: (code, min, link) => ({
    subject: `Bilig: your confirmation code ${code}`,
    text: `Your Bilig sign-up confirmation code: ${code}\nThe code is valid for ${min} minutes.\n\nOr open this link:\n${link}\n\nIf you did not sign up, ignore this e-mail.`,
  }),
};

const EXISTS_MAIL: Record<Lang, (link: string) => { subject: string; text: string }> = {
  ky: (link) => ({
    subject: 'Bilig: сизде аккаунт бар',
    text: `Бул e-mail менен Bilig'де аккаунт мурунтан эле бар — жаңысын түзүүнүн кереги жок.\nСырсөздү унутсаңыз, аны ушул шилтеме менен калыбына келтириңиз (30 мүнөт жарактуу):\n${link}\n\nЭгер сиз катталууга аракет кылбасаңыз, бул катты көңүлгө албаңыз.`,
  }),
  ru: (link) => ({
    subject: 'Bilig: у вас уже есть аккаунт',
    text: `С этим e-mail в Bilig уже есть аккаунт — новый создавать не нужно.\nЕсли вы забыли пароль, восстановите его по ссылке (действует 30 минут):\n${link}\n\nЕсли вы не пытались зарегистрироваться, просто проигнорируйте это письмо.`,
  }),
  en: (link) => ({
    subject: 'Bilig: you already have an account',
    text: `There is already a Bilig account with this e-mail — no need to create another.\nIf you forgot your password, reset it with this link (valid for 30 minutes):\n${link}\n\nIf you did not try to sign up, ignore this e-mail.`,
  }),
};

export const codeMail = (lang: Lang, code: string, minutes: number, link: string) => (CODE_MAIL[lang] ?? CODE_MAIL.ky)(code, minutes, link);
export const accountExistsMail = (lang: Lang, link: string) => (EXISTS_MAIL[lang] ?? EXISTS_MAIL.ky)(link);
