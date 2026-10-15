/** Admin test world: one user per role/scope with admin-audience tokens. */
import { makeClass, makeSchool, makeStudent, makeUser, tokenFor, type MadeUser, type TestCtx } from './helpers.js';

export async function makeAdminWorld(t: TestCtx) {
  const d = t.deps;
  const school = await makeSchool(d);
  const otherSchool = await makeSchool(d, 'Школа №2');
  const teacher = await makeUser(d, { role: 'teacher', scopeId: school.id });
  const schoolAdmin = await makeUser(d, { role: 'school_admin', scopeId: school.id });
  const cls = await makeClass(d, school.id, teacher.user.id);
  const student = await makeStudent(d, cls.id);
  const studentU: MadeUser = { user: student.user, token: student.token, adminToken: await tokenFor(d, student.user, 'admin') };
  const author = await makeUser(d, { role: 'author', scopeId: 'bio' });
  const authorOther = await makeUser(d, { role: 'author', scopeId: 'chem' });
  const translator = await makeUser(d, { role: 'author', scopeId: 'bio', subrole: 'translator' });
  const editor = await makeUser(d, { role: 'editor', scopeId: 'bio' });
  const editorOther = await makeUser(d, { role: 'editor', scopeId: 'chem' });
  const superadmin = await makeUser(d, { role: 'superadmin' });
  return { school, otherSchool, cls, teacher, schoolAdmin, student: studentU, author, authorOther, translator, editor, editorOther, superadmin };
}
export type AdminWorld = Awaited<ReturnType<typeof makeAdminWorld>>;
