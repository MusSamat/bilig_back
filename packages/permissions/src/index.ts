/**
 * @bilig/permissions — RBAC with scope (TZ §2).
 *
 * Rule of implementation (TZ): permissions are checked ONLY on the backend
 * against this permission list. The frontend consumes the same list
 * (`grantedPermissions`) and merely hides buttons the user cannot use. This
 * package is framework-agnostic so bilig_back and bilig_ft import the exact
 * same definitions (bilig_back vendors a byte-for-byte copy; see
 * `npm run contract:hash`).
 *
 * Semantics (explicit and tested):
 *  - Each role has exactly one legal scope type (ROLE_SCOPE). A grant whose
 *    scope does not match its role (e.g. `teacher` on `platform`), or whose
 *    non-platform scope has no `scopeId`, is INVALID and ignored entirely.
 *    This closes the old hole where an 'own' grant with platform scope passed
 *    every resource.
 *  - 'all'   : allowed for any resource (no scope match needed).
 *  - 'own'   : allowed only when the resource lies inside the grant's scope
 *              instance ("своё" = only inside your own area): school grants
 *              match `resource.schoolId`, subject grants `resource.subjectId`,
 *              class grants `resource.classId`. Missing context => deny.
 *  - 'limit' : allowed; the caller enforces the quota (guest tutor questions).
 *  - false   : denied.
 *  - Author sub-roles (methodist, artist, translator) are an optional
 *    `subrole` on an author grant. They narrow which content permissions the
 *    grant confers and which field groups it may edit (SUBROLE_FIELDS).
 */

/** Contract version shared by @bilig/permissions and @bilig/content-model. */
export const CONTRACT_VERSION = '0.9.3';

/** A role is granted with a scope: the whole platform, a school, a subject, or a class. */
export type Scope = 'platform' | 'school' | 'subject' | 'class';
export const SCOPES: readonly Scope[] = ['platform', 'school', 'subject', 'class'];

export type Role =
  | 'guest'
  | 'student'
  | 'teacher'
  | 'school_admin'
  | 'author'
  | 'editor'
  | 'manager' // v0.8.0: platform staff — content and teacher support; rights = the permissions SuperAdmin ticks
  | 'superadmin';

export const ROLES: readonly Role[] = [
  'guest',
  'student',
  'teacher',
  'school_admin',
  'author',
  'editor',
  'manager',
  'superadmin',
];

/**
 * The single legal scope type for each role (TZ §2 table, column «Область»).
 * `guest` has no scope: it is the implicit role of a principal without grants.
 */
export const ROLE_SCOPE: Record<Role, Scope | null> = {
  guest: null,
  student: 'class',
  teacher: 'school',
  school_admin: 'school',
  author: 'subject',
  editor: 'subject',
  manager: 'platform',
  superadmin: 'platform',
};

/** Author sub-roles (TZ §2: «Методист, 3D-художник или переводчик»). */
export type AuthorSubrole = 'methodist' | 'artist' | 'translator';
export const AUTHOR_SUBROLES: readonly AuthorSubrole[] = ['methodist', 'artist', 'translator'];

/** Every protected action in the system. Checked by code, never by role name. */
export type Permission =
  | 'demo.view' // Смотреть открытые демо-темы
  | 'topic.view' // Смотреть все темы по лицензии школы
  | 'assistant.ask.online' // Спрашивать помощника онлайн
  | 'quiz.attempt.save' // Проходить тесты с сохранением
  | 'class.manage' // Создавать классы и коды входа
  | 'assignment.manage' // Выдавать задания, смотреть результаты класса
  | 'school.teachers.manage' // Управлять учителями школы
  | 'content.draft.edit' // Редактировать черновики контента
  | 'model.upload' // Загружать 3D-модели
  | 'content.publish' // Публиковать и снимать с публикации
  | 'platform.manage' // Управлять предметами, школами, лицензиями
  | 'audit.view' // Смотреть журнал аудита
  | 'lesson.plan' // v0.5.0: КТП и планы уроков (своё)
  // v0.8.0 — staff (manager / SuperAdmin)
  | 'teacher.view' // Список учителей, поиск, открыть кабинет учителя (просмотр)
  | 'teacher.edit' // Режим правки в кабинете учителя (с причиной и 2FA)
  | 'content.review' // Принять и подтвердить контент
  | 'staff.manage' // Создавать, блокировать менеджеров, менять их права
  | 'audit.read' // Журнал действий (менеджер — свои записи)
  | 'deletion.request' // Запросить удаление учителя или контента
  | 'deletion.approve'; // Подтвердить запрос и удалить

export const PERMISSIONS: readonly Permission[] = [
  'demo.view',
  'topic.view',
  'assistant.ask.online',
  'quiz.attempt.save',
  'class.manage',
  'assignment.manage',
  'school.teachers.manage',
  'content.draft.edit',
  'model.upload',
  'content.publish',
  'platform.manage',
  'audit.view',
  'lesson.plan',
  'teacher.view',
  'teacher.edit',
  'content.review',
  'staff.manage',
  'audit.read',
  'deletion.request',
  'deletion.approve',
];

/**
 * Grant level for a permission within a role:
 *  - 'all'   : allowed without a scope-instance check
 *  - 'own'   : allowed only on resources inside the grant's own scope ("своё")
 *  - 'limit' : allowed but rate/quantity limited (guest assistant questions)
 *  - false   : denied
 */
export type Grant = 'all' | 'own' | 'limit' | false;

/**
 * The permission matrix — a literal transcription of the TZ §2 table.
 * «да» → 'all', «своё» → 'own', «лимит» → 'limit', «—» → false.
 * NB: «Проходить тесты с сохранением» is granted ONLY to student and teacher;
 * superadmin does NOT have it.
 */
export const MATRIX: Record<Permission, Record<Role, Grant>> = {
  'demo.view': {
    guest: 'all', student: 'all', teacher: 'all', school_admin: 'all',
    author: 'all', editor: 'all', manager: 'all', superadmin: 'all',
  },
  'topic.view': {
    guest: false, student: 'all', teacher: 'all', school_admin: 'all',
    author: 'all', editor: 'all', manager: 'all', superadmin: 'all',
  },
  'assistant.ask.online': {
    guest: 'limit', student: 'all', teacher: 'all', school_admin: 'all',
    author: 'all', editor: 'all', manager: 'all', superadmin: 'all',
  },
  'quiz.attempt.save': {
    guest: false, student: 'all', teacher: 'all', school_admin: false,
    author: false, editor: false, manager: false, superadmin: false,
  },
  'class.manage': {
    guest: false, student: false, teacher: 'own', school_admin: 'own',
    author: false, editor: false, manager: false, superadmin: 'all',
  },
  'assignment.manage': {
    guest: false, student: false, teacher: 'own', school_admin: 'own',
    author: false, editor: false, manager: false, superadmin: 'all',
  },
  'school.teachers.manage': {
    guest: false, student: false, teacher: false, school_admin: 'own',
    author: false, editor: false, manager: false, superadmin: 'all',
  },
  'content.draft.edit': {
    guest: false, student: false, teacher: false, school_admin: false,
    author: 'own', editor: 'own', manager: 'all', superadmin: 'all',
  },
  'model.upload': {
    guest: false, student: false, teacher: false, school_admin: false,
    author: 'own', editor: 'own', manager: 'all', superadmin: 'all',
  },
  'content.publish': {
    guest: false, student: false, teacher: false, school_admin: false,
    author: false, editor: 'own', manager: 'all', superadmin: 'all',
  },
  'platform.manage': {
    guest: false, student: false, teacher: false, school_admin: false,
    author: false, editor: false, manager: 'all', superadmin: 'all',
  },
  'audit.view': {
    guest: false, student: false, teacher: false, school_admin: 'own',
    author: false, editor: false, manager: 'own', superadmin: 'all',
  },
  // v0.5.0 (beyond the TZ §2 table): a teacher's own КТП and lesson plans; records are owner-only.
  'lesson.plan': {
    guest: false, student: false, teacher: 'all', school_admin: 'all',
    author: false, editor: false, manager: false, superadmin: 'all',
  },  // v0.8.0 — staff. A manager holds only the permissions SuperAdmin ticked (RoleGrant.permissions);
  // the matrix is the ceiling. Teachers' own classes / КТП: staff act through the teacher's
  // cabinet (a support session), never directly.
  'teacher.view': {
    guest: false, student: false, teacher: false, school_admin: false,
    author: false, editor: false, manager: 'all', superadmin: 'all',
  },
  'teacher.edit': {
    guest: false, student: false, teacher: false, school_admin: false,
    author: false, editor: false, manager: 'all', superadmin: 'all',
  },
  'content.review': {
    guest: false, student: false, teacher: false, school_admin: false,
    author: false, editor: 'own', manager: 'all', superadmin: 'all',
  },
  'staff.manage': {
    guest: false, student: false, teacher: false, school_admin: false,
    author: false, editor: false, manager: false, superadmin: 'all',
  },
  'audit.read': {
    guest: false, student: false, teacher: false, school_admin: false,
    author: false, editor: false, manager: 'own', superadmin: 'all',
  },
  'deletion.request': {
    guest: false, student: false, teacher: false, school_admin: false,
    author: false, editor: false, manager: 'all', superadmin: 'all',
  },
  'deletion.approve': {
    guest: false, student: false, teacher: false, school_admin: false,
    author: false, editor: false, manager: false, superadmin: 'all',
  },
};

/**
 * Editable field groups of a content document (topic/concept/process/item):
 *  - 'structure': keys, scene binding, concepts, activities, items, props…
 *  - 'strings'  : localized text (Localized values, i18n status)
 *  - 'assets'   : 3D models, thumbnails, media and their licence metadata
 */
export type ContentField = 'structure' | 'strings' | 'assets';
export const CONTENT_FIELDS: readonly ContentField[] = ['structure', 'strings', 'assets'];

/**
 * What each author sub-role may edit (TZ §2: «подроли сужают права
 * редактирования»). An author without a subrole edits everything.
 */
export const SUBROLE_FIELDS: Record<AuthorSubrole, readonly ContentField[]> = {
  methodist: ['structure', 'strings'],
  artist: ['assets'],
  translator: ['strings'],
};

/**
 * Content permissions each author sub-role keeps. Non-content permissions
 * (demo.view, topic.view, assistant.ask.online) are unaffected by subroles.
 */
export const SUBROLE_PERMISSIONS: Record<AuthorSubrole, readonly Permission[]> = {
  methodist: ['content.draft.edit'],
  artist: ['content.draft.edit', 'model.upload'],
  translator: ['content.draft.edit'],
};

const CONTENT_PERMISSIONS: readonly Permission[] = ['content.draft.edit', 'model.upload'];

/** A role granted to a user, bound to a concrete scope instance. */
export interface RoleGrant {
  role: Role;
  scope: Scope;
  /** Id of the scope instance (schoolId, subjectId, classId). Omitted for platform. */
  scopeId?: string;
  /** Author sub-role; only meaningful when `role === 'author'` (ignored otherwise). */
  subrole?: AuthorSubrole;
  /**
   * v0.8.0: the permissions SuperAdmin ticked for a manager (StaffProfile).
   * Only meaningful when `role === 'manager'`; a manager holds a permission
   * only if it is listed here AND the matrix allows it (MANAGER_ALWAYS aside).
   */
  permissions?: Permission[];
}

/** The resolved principal the backend builds from the auth token. */
export interface Principal {
  userId: string | null; // null => guest
  grants: RoleGrant[];
}

/** Context identifying which resource an action targets, for 'own' checks. */
export interface ResourceContext {
  schoolId?: string;
  subjectId?: string;
  classId?: string;
}

export const GUEST: Principal = { userId: null, grants: [] };

/**
 * A grant is valid when its scope matches the role's legal scope and, for any
 * non-platform scope, carries a concrete `scopeId`. Invalid grants are ignored
 * by every check in this module.
 */
export function isValidGrant(g: RoleGrant): boolean {
  if (!ROLES.includes(g.role) || g.role === 'guest') return false;
  if (g.scope !== ROLE_SCOPE[g.role]) return false;
  if (g.scope !== 'platform' && !g.scopeId) return false;
  if (g.subrole !== undefined && !AUTHOR_SUBROLES.includes(g.subrole)) return false;
  return true;
}

/** Grant level a single (valid) role grant confers for a permission, after subrole narrowing. */
export function grantLevel(g: RoleGrant, permission: Permission): Grant {
  if (!isValidGrant(g)) return false;
  const base = MATRIX[permission]?.[g.role] ?? false;
  if (g.role === 'manager' && base !== false && !MANAGER_ALWAYS.includes(permission) && !(g.permissions ?? []).includes(permission)) {
    return false;
  }
  if (
    base !== false &&
    g.role === 'author' &&
    g.subrole &&
    CONTENT_PERMISSIONS.includes(permission) &&
    !SUBROLE_PERMISSIONS[g.subrole].includes(permission)
  ) {
    return false;
  }
  return base;
}

/** v0.8.0: what every manager has without a tick (reading the platform as a teacher would). */
export const MANAGER_ALWAYS: readonly Permission[] = ['demo.view', 'topic.view', 'assistant.ask.online'];
/** v0.8.0: the checkboxes SuperAdmin sees when creating a manager. */
export const MANAGER_ASSIGNABLE: readonly Permission[] = (Object.keys(MATRIX) as Permission[]).filter(
  (p) => MATRIX[p].manager !== false && !MANAGER_ALWAYS.includes(p),
);

const ORDER: Grant[] = [false, 'limit', 'own', 'all'];
function strongest(a: Grant, b: Grant): Grant {
  return ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;
}

const validGrants = (p: Principal): RoleGrant[] => p.grants.filter(isValidGrant);

/** True when the principal has no valid grants and therefore acts as a guest. */
export function isGuest(principal: Principal): boolean {
  return validGrants(principal).length === 0;
}

/** The strongest grant level a principal has for a permission (false if none). */
export function grantFor(principal: Principal, permission: Permission): Grant {
  const grants = validGrants(principal);
  if (grants.length === 0) return MATRIX[permission].guest;
  let best: Grant = false;
  for (const g of grants) best = strongest(best, grantLevel(g, permission));
  return best;
}

/** Does the resource lie inside this grant's scope instance? */
export function grantCoversResource(g: RoleGrant, resource: ResourceContext): boolean {
  switch (g.scope) {
    case 'platform':
      return true;
    case 'school':
      return !!resource.schoolId && g.scopeId === resource.schoolId;
    case 'subject':
      return !!resource.subjectId && g.scopeId === resource.subjectId;
    case 'class':
      return !!resource.classId && g.scopeId === resource.classId;
    default:
      return false;
  }
}

/**
 * Authoritative check. `resource` is required to resolve 'own' grants.
 * 'limit' is treated as allowed here; callers enforce the actual quota separately.
 */
export function can(
  principal: Principal,
  permission: Permission,
  resource: ResourceContext = {},
): boolean {
  const grants = validGrants(principal);
  if (grants.length === 0) return MATRIX[permission].guest !== false;
  return grants.some((g) => {
    const level = grantLevel(g, permission);
    if (level === false) return false;
    if (level === 'all' || level === 'limit') return true;
    return grantCoversResource(g, resource); // 'own'
  });
}

/**
 * Field groups the principal may edit on a content resource (A-06/A-11).
 * Requires `content.draft.edit` on that resource; author sub-roles narrow it.
 */
export function editableFields(
  principal: Principal,
  resource: ResourceContext = {},
): ContentField[] {
  const out = new Set<ContentField>();
  for (const g of validGrants(principal)) {
    const level = grantLevel(g, 'content.draft.edit');
    if (level === false) continue;
    if (level === 'own' && !grantCoversResource(g, resource)) continue;
    const fields =
      g.role === 'author' && g.subrole ? SUBROLE_FIELDS[g.subrole] : CONTENT_FIELDS;
    fields.forEach((f) => out.add(f));
  }
  return CONTENT_FIELDS.filter((f) => out.has(f));
}

/** Convenience: may the principal edit this field group of the resource? */
export function canEditField(
  principal: Principal,
  field: ContentField,
  resource: ResourceContext = {},
): boolean {
  return editableFields(principal, resource).includes(field);
}

/**
 * Flat list of permissions the principal holds anywhere (for the FE to hide
 * buttons; returned by GET /me). Scope-instance checks still happen on the backend.
 */
export function grantedPermissions(principal: Principal): Permission[] {
  return PERMISSIONS.filter((p) => grantFor(principal, p) !== false);
}
