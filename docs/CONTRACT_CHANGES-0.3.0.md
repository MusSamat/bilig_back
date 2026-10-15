# Contract 0.3.0: changes for the admin and client requests

Contract `@bilig/content-model` and `@bilig/permissions` 0.2.1 → **0.3.0**.
Everything is additive and backwards compatible:

- new response fields are optional;
- new query and body fields are optional;
- existing endpoints keep their behaviour when the new parameters are absent;
- If-Match stays optional where it was not required before.

Migration: `prisma/migrations/20261015150000_contract_0_3_0` (new columns with
defaults, plus an `AssetVersion` table backfilled from existing assets).

Sources: `bilig_ft/src/admin/CONTRACT_REQUESTS.md` (A-1…A-19) and
`bilig_ft/CONTRACT_REQUESTS.md` (C-1…C-8).

## Admin requests

| # | Request | Resolution |
|---|---|---|
| A-1 | Server-side sorting | **Done.** `sort` + `order=asc\|desc` (`SortOrderSchema`, `sortQuery()`) on `AdminListQuerySchema` and on the user, audit, build, licence, strings, school, invite and asset list queries, so `supportsServerSort()` turns on. The generic dictionary and topic lists take a field name (`ADMIN_SORT_FIELD_RE`): `key`, `updatedAt`, `createdAt`, `title` (localized), any top-level field of the entity (arrays sort by length). Topics also sort by `unitKey`, `status`, `publishedVersion` and `latestVersion` (semver order). The fixed lists take enums that include every column the admin sorts today. Cursors are keyset over (value, tie), so pages stay stable. Without `sort` the old order and cursors are unchanged. Builds sort only by `createdAt` (`order=desc` = newest first), because a build row carries the whole package. |
| A-2 | More filters | **Done.** `AdminListQuerySchema`: `unitKey` (topics and objectives), `authorId` and `mine=true` (topics: author of the latest version; dictionary: last editor). `GET /admin/concepts?kind=`, `GET /admin/items?type=&objectiveKey=`, `GET /admin/builds?status=`, `GET /admin/audit?from=&to=&targetId=`. `actorId` also accepts a hex prefix of 4 or more characters. Also added: `GET /admin/subjects?status=soon\|live`, schools `q/region/status`, licences `active`, invites `status/q`, assets `q/kind/status`. **Partly declined:** `status` stays `string` instead of an enum, because narrowing the input type would break callers that pass a `string`. The server validates it: an unknown topic or subject status returns 400. |
| A-3 | Topic rows without a title | **Done.** `AdminTopic.title` (from the latest version), `updatedBy` (new `Topic.updatedBy` column, set by every write through the topic), `authorId` and `createdAt`. All are optional. |
| A-4 | Schools and licences have no version | **Done.** `School.version` and `License.version` (columns default to 1, bumped on every write). `adminSchoolPatch`, `adminLicensePatch` and `adminLicenseDelete` have the new flag `ifMatchOptional: true`: send If-Match or a body `version`, and a stale one returns 409 `version_mismatch`. Without one, the last write still wins (0.2.1 behaviour). |
| A-5 | Strings PATCH has no precondition | **Done.** Each item takes an optional `version` (row version, 0 = the row did not exist) and/or `sourceHash` (the ru source the translation was made from). A stale value returns 409, and nothing in the request is written. `LocaleString.version` and `updatedAt` are returned. |
| A-6 | Partial PATCH cannot clear an optional field | **Done.** In every `withVersion(...)` patch schema (subjects, groups, courses, units, objectives, concepts, processes, glossary), optional fields also accept `null`, which removes the field. `null` on a required field returns 400. |
| A-7 | One locale per request | **Done.** New `GET /admin/strings/rows?locales=ru,ky,en&q=&prefix=&status=&untranslated=&sourceChanged=` returns `{ key, values, status, versions, sourceHash, sourceChanged, sourceChangedLocales }`. `GET /admin/strings` also takes `q`, `prefix` and `sort`. |
| A-8 | No machine-translation trigger | **Declined (informational).** No MT provider is configured or contracted. `machine` is accepted by PATCH and import, so an external MT job can write drafts through the existing endpoints. |
| A-9 | Review comments (A-14) | **Done.** `GET /admin/review-comments?targetType=&targetId=&resolved=&authorId=`, `POST /admin/review-comments`, and `PATCH /admin/review-comments/:id` (`{ resolved }` resolves or reopens; `{ body }` edits, author only). `ReviewComment` gains `authorId`, `createdAt`, `resolvedBy` and `topicVersion`. `authorId` and `createdAt` are always sent but typed optional, because the 0.2.1 admin builds local drafts of this type. Access requires `content.draft.edit` in the target's subject. Without a target, only visible comments are listed. Reject reasons are still stored as comments. |
| A-10 | Rights and sources on a topic | **Done.** `Topic.rights?: { license, author, source, notes?, covers? }[]`. The publish checklist warns (`rights_missing`, a warning that does not block) when the topic has a 3D asset and no entry. |
| A-11 | Asset metadata, versions, delete | **Done.** `AssetReport` gains `filename`, `kind`, `contentType`, `license`, `author`, `source`, `createdAt`, `createdBy`, `version` and `completedAt` (all optional). New `GET /admin/assets/:id/versions` and `POST /admin/assets/:id/versions` (a new file for the same key becomes the current version; rights can change with it). New `DELETE /admin/assets/:id` returns 409 `in_use` while a topic version references the asset key in `scene.asset` or `rights[].covers`. |
| A-12 | Multipart complete | **Done.** `POST /admin/assets/:id/complete { uploadId?, parts: [{ partNumber, etag }] }` checks that parts are numbered 1..n and is idempotent. It calls the storage's `completeMultipart` when the adapter has one (S3). On local or memory storage, `parts` may be empty. `/process` still works without this step. |
| A-13 | Concept usage is partial | **Done.** `ConceptUsage.usedBy`: `topic:…`, `process:…` and `concept:…`. This is the same list that blocks the delete. |
| A-14 | No GET by key for groups and glossary terms | **Done.** `GET /admin/groups/:key` and `GET /admin/glossary/:id`. |
| A-15 | Scheduled publish cannot be cancelled | **Done.** `DELETE /admin/topics/:id/schedule` (`content.publish`, optional If-Match = topic version). The topic stays in `review`. Returns 409 when nothing is scheduled. Audited as `content.schedule_cancelled`. `WORKFLOW_ACTIONS` is unchanged, so exhaustive switches still compile. |
| A-16 | Admin 2FA enrolment | **Done.** On an admin login without TOTP, the 403 `detail: totp_enrollment_required` problem now carries `enrollmentToken`, valid for 10 minutes for that user and used up by a successful verify. `POST /auth/2fa/setup { enrollmentToken }` returns `otpauthUrl`. `POST /auth/2fa/verify { enrollmentToken, code }` returns a `TokenResponse` and sets the admin refresh cookie. Both endpoints are rate-limited. The old client-audience workaround still works. |
| A-17 | Invite revoke and resend | **Done.** `DELETE /admin/invites/:id` (a revoked link is refused at accept) and `POST /admin/invites/:id/resend` (new token, new 7-day expiry, lifts a revocation). Both return 409 once accepted. `Invite` gains `status` (`pending\|accepted\|revoked\|expired`), `revokedAt`, `createdAt` and `invitedBy`. The scope rules are the same as for creating an invite. |
| A-18 | Reveal a pupil «с основанием» | **Done.** `POST /admin/users/:id/reveal { ground, reason (≥10 chars), reference? }` (superadmin, pupils only) returns the real name, classes and schools, and `auditId`. The audit entry `student.data_reveal` stores the ground, reason and reference. Lists and GETs stay pseudonymised. Sorting users by `displayName` sorts pupils by their pseudonym, so the order does not leak names. |
| A-19 | Tutor regression run | **Done.** `POST /admin/tutor-settings/regression { topicKey?, indexes? }` returns per question `answer`, `citations`, `missing` expected concepts, `passed`, `refused`, `noAnswer`, `error` and tokens. Each regression question can now carry a `topicKey`. It uses the same grounding and refusal rules as `/tutor/ask`. Nothing is stored as a thread. Tokens count against the daily budget. A run is limited to 50 questions (`TUTOR_REGRESSION_MAX`; use `indexes` for batches). It runs while the tutor is disabled for users, but returns 503 without a provider. |

## Client requests

| # | Request | Resolution |
|---|---|---|
| C-1 | Topic info in `MyAssignment` | **Done.** Optional `topicTitle` (in Accept-Language), `subjectKey`, `grade` and `unitKey`, taken from the published package. They are absent when the topic is no longer published. |
| C-2 | Pagination for assignment results | **Done.** `GET /assignments/:id/results?cursor=&limit=` pages `students` in name order and adds `nextCursor` and `totalStudents`. `averageScore` and `hardestItems` always cover the whole class. Without parameters, every student is returned, as before. |
| C-3 | Localized prompt in `hardestItems` | **Done.** `hardestItems[].prompt` in the request language. |
| C-4 | Absolute `TopicSummary.thumb` | **Done.** Catalog and course responses resolve `thumb` to an absolute, hash-addressed URL and add `filesBaseUrl`. This is the same base as the manifest response. `summarizeTopic()` still yields the package-relative path. |
| C-5 | `TopicSummary.conceptKeys` | **Done.** It is in `summarizeTopic()`, so the API, the mocks and offline catalogs all get it. |
| C-6 | Topic-level sample props | **Done.** `Topic.props?: ConceptProp[]` and `Sample.props?: ConceptProp[]`, checked by `validatePackage` against the property-type dictionary. Topic props are also given to the tutor as material. |
| C-7 | Engine parameter conventions | **Done (documented).** `ENGINE_PARAMS` in `process.ts` lists the keys each engine reads: `timeline` `<metric>@<step>`; `stoich` `n0.<sp>` / `nu.<sp>` or the content form `<sp>` + `M_<sp>` + `dH_kJ`; `ode` `omega`, `zeta`, `x0`, `v0`, `mass`. Added helpers `stepTargetKey()` and `stepTargets()`. Adding per-step targets to the existing `timeline` content is a content task. |
| C-8 | `LANGS` beyond three | **Designed, active set unchanged (ky/ru/en).** UI-only languages need no contract change: `UiLangCodeSchema` / `isUiLangCode()` accept any code, and `contentLangFor(ui)` picks the content language (exact match, then base subtag, then fallback). A future content language will be added as an **optional** key of `LocalizedSchema`, so existing data stays valid and `missingLangs` / `t()` handle the gap. `isLocalizedValue()` replaces "exactly three keys" checks; the backend already uses it. |

## Other additive contract changes

- `ProblemSchema.enrollmentToken?`
- `EndpointDef.ifMatchOptional?`. In the route helper, `ctx.ifMatch` is `-1` when an optional If-Match is absent.
- `ASSET_STATUSES`, `INVITE_STATUSES`, `REVIEW_TARGET_TYPES` and `REVEAL_GROUNDS`.
- `RightsEntrySchema`, `StringRowSchema`, `AssetVersionSchema`, `StudentRevealSchema` and `TutorRegressionResultSchema`.

## New endpoints

`authTotpEnrollSetup`, `authTotpEnrollVerify`, `adminGroupGet`,
`adminGlossaryGet`, `adminTopicScheduleCancel`, `adminReviewCommentList`,
`adminReviewCommentCreate`, `adminReviewCommentPatch`, `adminAssetVersions`,
`adminAssetVersionCreate`, `adminAssetComplete`, `adminAssetDelete`,
`adminStringRows`, `adminInviteRevoke`, `adminInviteResend`, `adminUserReveal`,
`adminTutorRegression`.

## Notes for bilig_ft

The two `src/admin` tests below exercised the 0.2.1 workarounds. They need
updating in `src/` (they are not contract breakage):

- `i18n.test.ts`: new form fields `rights`, `covers` and `notes` need labels.
- `lists/list.test.tsx`: the "sorted on the loaded page only" hint disappears now that `adminTopicList` sorts on the server.
