# Contract 0.8.0: roles, the teacher's cabinet from the admin, the action journal

Contract `@bilig/content-model` and `@bilig/permissions` 0.7.0 → **0.8.0**.
Product spec: three working roles — teacher, manager, SuperAdmin. A manager
signs in only to the admin and opens a chosen teacher's cabinet from there
for support. Everything staff do is written to an append-only journal.

## 1. Roles and permissions (`packages/permissions`)

- New role **`manager`** (scope `platform`). Its rights are the permissions
  SuperAdmin ticks when creating it: `RoleGrant.permissions` (stored in
  `StaffProfile.permissions`). The matrix is the ceiling: a manager holds a
  permission only if it is ticked AND the matrix allows it. `MANAGER_ALWAYS`
  (demo.view, topic.view, assistant.ask.online) needs no tick;
  `MANAGER_ASSIGNABLE` is the list of checkboxes.
- New permissions: `teacher.view` (teachers list, search, open a cabinet to
  view), `teacher.edit` (edit mode in a cabinet), `content.review`,
  `staff.manage` (SuperAdmin only), `audit.read` (manager: own records,
  SuperAdmin: all), `deletion.request` (manager), `deletion.approve`
  (SuperAdmin only).

| Area | Teacher | Manager | SuperAdmin |
|---|---|---|---|
| Own classes, subjects, КТП, plans | yes | through the teacher's cabinet | through the teacher's cabinet |
| All classes 1–12 and subjects (curriculum, content) | no | yes (ticked) | yes |
| Content: create, review, publish | no | yes (ticked) | yes |
| Deleting teachers / content | no | request only | yes |
| Teachers list, search, open cabinet | no | yes (ticked) | yes |
| Create / block managers | no | no | yes |
| Journal | no | own records | all |

- **Migration of existing accounts:** `author` and `editor` grants become
  `manager` with the matching content permissions (author →
  content.draft.edit, model.upload; editor → + content.publish,
  content.review); no one loses access. `school_admin` and `student` stay
  in the code, dormant. A manager can never change their own role or
  permissions; there must always be at least two active SuperAdmins once
  two exist (blocking/deleting/demoting below two is refused).
- The server checks every permission; menus and routes in the client are
  built from `me.permissions` only for display.

## 2. Staff sign-in

- Staff sign in only at **/admin** (e-mail + password + TOTP, the admin
  audience). The role decides the route: manager and SuperAdmin → the
  admin; a teacher who signs in at /admin is sent to their cabinet; staff
  cannot use the public teacher sign-in (phone) and get the admin link.
- Manager lifecycle: SuperAdmin invites (e-mail, name, ticked permissions)
  → the manager accepts the invite, sets a password and enrols TOTP
  (mandatory) → active. Block and soft delete keep history; restore is
  possible; no shared accounts. Endpoints `staff*`.

## 3. The teacher's cabinet from the admin (support sessions)

- `POST /admin/teachers/:id/support { mode: view | edit, reason?, totp? }`
  creates an `ImpersonationSession` (15 min view / 30 min edit, no
  refresh) and returns a client-audience access token whose `sub` is the
  teacher and `act` the staff member, plus the mode and session id.
  - view needs `teacher.view`; edit needs `teacher.edit`, a reason (≥ 10
    characters) and the staff member's TOTP again.
  - A staff account (manager, SuperAdmin, author, editor) is never opened.
- Inside a session the client shows on every page a persistent banner «Вы в
  кабинете: <teacher>. Режим поддержки (просмотр | правка)» with «Выйти в
  админку»; `GET /me` carries `support { sessionId, mode, actor, expiresAt }`.
- Forbidden in every mode (403 `support_forbidden`): password, phone,
  e-mail, 2FA, deleting the account, payment, ending other sessions; the
  teacher's private «Мои материалы» (when they exist) are hidden. View mode:
  every write is 403 `support_read_only`.
- The teacher is not notified; the journal is the only trace, so every
  request in a session that changes data — and the start and end of the
  session — is journaled with both ids (actor and on-behalf-of).
- `POST /admin/support/:sessionId/end` ends it (also on expiry).

## 4. The action journal (`AuditEvent`)

- One append-only table. Enforcement: a database trigger rejects UPDATE and
  DELETE on it (the app's DB user owns its tables, so revoking privileges is
  not enough); every row stores `prevHash` and `hash =
  sha256(prevHash ‖ canonical JSON of the row)`; `GET /admin/journal/verify`
  walks the chain. Monthly partitions, retention 3 years (older partitions
  dropped by a scheduled job; dropping is DDL, not row deletion).
- Fields: time, actor and role, on behalf of, group, action, object (type,
  id, label), values before / after (secrets never written), reason,
  result (ok / denied / failed), IP, user agent, request id, support session.
- Groups: `auth` (sign-in, 2FA), `staff` (created, invite accepted,
  blocked, restored, permissions changed, deleted), `support` (session
  started / ended, actions inside), `content` (created, sent to review,
  reviewed, published, deletion requested, deleted), `teacher_data`
  (profile, class, subject, КТП), `export` (CSV exports, mass operations),
  `deletion`.
- The existing `AuditLog` rows are copied into the journal by the migration
  (in time order, chained), so no history is lost; the old table stays read
  only and `GET /admin/audit` keeps answering from it.
- SuperAdmin UI: filters by staff member, group/action, period, object;
  CSV export (itself journaled); alerts — mass deletion (≥ 10 deletions by one
  actor in 10 minutes), a broken chain, a support session in edit mode.
- SuperAdmin actions are journaled too.

## 5. Deletion requests

A manager requests deletion of a teacher or content with a reason;
SuperAdmin approves (with TOTP) — the deletion runs then (teacher: soft
delete, sessions revoked; content: archived or removed as each kind allows)
— or rejects with a note. Every step is journaled.

## 6. The teacher's cabinet after sign-in

- The server computes the profile status and returns it in `/me`:
  `setup { name, school, teaching, teachingLang, classWithSubject }` and
  `profileStatus`. Minimum = full name, school, teaching language
  (`ky | ru | uz | en`, `PATCH /me { teachingLang }`), at least one class
  with at least one subject.
  1. Minimum not met → a setup screen with a checklist and progress.
  2. Minimum met → home «Мои классы»: tiles of the classes the teacher
     added (label as typed) and a «+ Добавить класс» tile.
  3. A class → its subjects (`GET /classes/:id/subjects`): КТП status (none
     / parsed, problems), the next lesson, progress.
  4. Everything else (upload a КТП, confirm the phone) — gentle hints, never
     blocks.
- Classes: `subjectKeys` (several subjects per class; `subjectKey` stays
  as the first one). A self-registered teacher's trial access follows their
  classes: the grades and subjects of their classes are covered
  automatically.
- КТП ↔ classes: `TeachingPlan.classLinks { "8б": classId | null }`, matched
  by name on upload (case and spaces ignored), editable via PATCH; the
  class's subject status uses the plan whose subject and link match.

## 7. Grades 1–12

Kyrgyzstan moves to 12-year schooling: every grade field accepts 1–12
(`g12` is a valid URL segment).
