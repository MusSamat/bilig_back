/**
 * Contract 0.8.0 §6: the teacher's profile status. Minimum = full name,
 * school, teaching language and at least one class with at least one subject.
 * Computed for self-registered teachers and for school teachers (their school
 * is set by the admins). `teaching` (the trial's subjects) is reported but is
 * not part of the minimum: a trial follows the teacher's classes.
 */
import { formatKgPhone, type MeResponse } from '@bilig/content-model/api';
import type { ClassRec, GrantRec, Repository, UserRec } from '../repo/types.js';
import { isPlaceholderSchoolName, selfTrial } from './teacher-signup.js';

export type ProfileSetup = NonNullable<MeResponse['setup']> & { teachingLang: boolean; classWithSubject: boolean };
export type ProfileStatus = 'incomplete' | 'complete';

/** Classes the user teaches (not deleted). */
export async function taughtClasses(repo: Repository, userId: string): Promise<ClassRec[]> {
  const ids = (await repo.listEnrollments({ userId, role: 'teacher' })).map((e) => e.classId);
  if (!ids.length) return [];
  return (await repo.listClasses({ ids }, { limit: 10_000 })).items;
}

export const isTeacher = (grants: readonly GrantRec[]) => grants.some((g) => g.role === 'teacher');

export const nameIsSet = (u: UserRec) => !!u.displayName.trim() && (!u.phone || u.displayName !== formatKgPhone(u.phone));

/** The setup checklist and status of a teacher; null for anyone else. */
export async function teacherProfile(repo: Repository, user: UserRec, grants?: GrantRec[]): Promise<{ setup: ProfileSetup; profileStatus: ProfileStatus } | null> {
  const gs = grants ?? (await repo.listGrants(user.id));
  if (user.kind !== 'adult' || !isTeacher(gs)) return null;
  const self = await selfTrial(repo, user.id);
  const classes = await taughtClasses(repo, user.id);
  const setup: ProfileSetup = {
    name: nameIsSet(user),
    school: self ? !isPlaceholderSchoolName(self.school.name) : gs.some((g) => g.role === 'teacher' && g.scope === 'school' && !!g.scopeId),
    teaching: self ? !!self.license?.subjects.length : true,
    teachingLang: !!user.teachingLang,
    classWithSubject: classes.some((c) => (c.subjectKeys ?? []).length > 0 || !!c.subjectKey),
  };
  const complete = setup.name && setup.school && setup.teachingLang && setup.classWithSubject;
  return { setup, profileStatus: complete ? 'complete' : 'incomplete' };
}
