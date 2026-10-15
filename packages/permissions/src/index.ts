/**
 * @bilig/permissions — RBAC with scope (TZ §2).
 *
 * Rule of implementation (TZ): permissions are checked ONLY on the backend
 * against this permission list. The frontend consumes the same list and merely
 * hides buttons the user cannot use. Keep this package framework-agnostic so
 * both bilig_back and bilig_ft import the exact same definitions.
 */

/** A role is granted with a scope: the whole platform, a school, a subject, or a class. */
export type Scope = 'platform' | 'school' | 'subject' | 'class';

export type Role =
  | 'guest'
  | 'student'
  | 'teacher'
  | 'school_admin'
  | 'author'
  | 'editor'
  | 'superadmin';

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
  | 'audit.view'; // Смотреть журнал аудита

/**
 * Grant level for a permission within a role:
 *  - 'all'   : allowed across the role's scope without ownership restriction
 *  - 'own'   : allowed only on resources inside the actor's own scope ("своё")
 *  - 'limit' : allowed but rate/quantity limited (e.g. guest assistant questions)
 *  - false   : denied
 */
export type Grant = 'all' | 'own' | 'limit' | false;

/**
 * The permission matrix (TZ §2). Columns of the TZ table become rows here:
 * for each permission, the grant level per role.
 */
export const MATRIX: Record<Permission, Record<Role, Grant>> = {
  'demo.view': {
    guest: 'all', student: 'all', teacher: 'all', school_admin: 'all',
    author: 'all', editor: 'all', superadmin: 'all',
  },
  'topic.view': {
    guest: false, student: 'all', teacher: 'all', school_admin: 'all',
    author: 'all', editor: 'all', superadmin: 'all',
  },
  'assistant.ask.online': {
    guest: 'limit', student: 'all', teacher: 'all', school_admin: 'all',
    author: 'all', editor: 'all', superadmin: 'all',
  },
  'quiz.attempt.save': {
    guest: false, student: 'all', teacher: 'all', school_admin: false,
    author: false, editor: false, superadmin: 'all',
  },
  'class.manage': {
    guest: false, student: false, teacher: 'own', school_admin: 'own',
    author: false, editor: false, superadmin: 'all',
  },
  'assignment.manage': {
    guest: false, student: false, teacher: 'own', school_admin: 'own',
    author: false, editor: false, superadmin: 'all',
  },
  'school.teachers.manage': {
    guest: false, student: false, teacher: false, school_admin: 'own',
    author: false, editor: false, superadmin: 'all',
  },
  'content.draft.edit': {
    guest: false, student: false, teacher: false, school_admin: false,
    author: 'own', editor: 'own', superadmin: 'all',
  },
  'model.upload': {
    guest: false, student: false, teacher: false, school_admin: false,
    author: 'own', editor: 'own', superadmin: 'all',
  },
  'content.publish': {
    guest: false, student: false, teacher: false, school_admin: false,
    author: false, editor: 'own', superadmin: 'all',
  },
  'platform.manage': {
    guest: false, student: false, teacher: false, school_admin: false,
    author: false, editor: false, superadmin: 'all',
  },
  'audit.view': {
    guest: false, student: false, teacher: false, school_admin: 'own',
    author: false, editor: false, superadmin: 'all',
  },
};

/** A role granted to a user, bound to a concrete scope instance. */
export interface RoleGrant {
  role: Role;
  scope: Scope;
  /** Id of the scope instance (schoolId, subjectId, classId). Undefined for platform. */
  scopeId?: string;
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
  /** For 'own' checks: the id of the user/owner the resource belongs to. */
  ownerId?: string;
}

/** The strongest grant a principal has for a permission (false if none). */
export function grantFor(principal: Principal, permission: Permission): Grant {
  let best: Grant = false;
  for (const g of principal.grants) {
    const level = MATRIX[permission]?.[g.role] ?? false;
    best = strongest(best, level);
  }
  // Guests have no explicit grant unless they carry the implicit guest role.
  if (principal.grants.length === 0) {
    return MATRIX[permission].guest;
  }
  return best;
}

const ORDER: Grant[] = [false, 'limit', 'own', 'all'];
function strongest(a: Grant, b: Grant): Grant {
  return ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;
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
  const grant = grantFor(principal, permission);
  if (grant === false) return false;
  if (grant === 'all' || grant === 'limit') return true;

  // grant === 'own': at least one role grant must match the resource's scope.
  return principal.grants.some((g) => {
    const level = MATRIX[permission][g.role];
    if (level !== 'own' && level !== 'all') return false;
    if (level === 'all') return true;
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
  });
}

/** Flat list of permissions the principal can perform (for the FE to hide buttons). */
export function grantedPermissions(principal: Principal): Permission[] {
  return (Object.keys(MATRIX) as Permission[]).filter(
    (p) => grantFor(principal, p) !== false,
  );
}

export const GUEST: Principal = { userId: null, grants: [] };
