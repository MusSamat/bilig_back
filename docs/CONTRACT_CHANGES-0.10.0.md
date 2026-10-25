# Contract 0.10.0: the teacher cabinet v3

Contract `@bilig/content-model` and `@bilig/permissions` 0.9.4 → **0.10.0**.
The cabinet is rebuilt around the lesson: Сегодня → Классы и КТП → Урок. A
teacher's КТП is the spine; every lesson of it gets its own page with a lesson
model, goals, materials and an assistant, and the «Сабактын планы» .docx is
filled from that page.

Design: claude.ai/design «Bilig Teacher Cabinet v3».

## Breaking (both repos ship together)

- `KtpRow.uid` (required): a stable row id. Rows stored before 0.10.0 get one
  on read (`r` + plan id prefix + index) and keep it on the next write.
- `KTP_LESSON_TYPES` gains `sor` (СОР, summative assessment of a chapter) and
  `soch` (СОЧ, of a quarter). The plan timings use those of `test`.
- `GET /classes/:id/assignments` items are `AssignmentSummary`
  (`displayTitle`, `subjectKey`, `done`, `totalStudents`, `averageScore`).
- `CONTRACT_VERSION` comparisons go through `contractAtLeast()` — `'0.10.0'`
  sorts before `'0.9.0'` as text.

## Additive

| What | Where |
|---|---|
| School calendar (quarters, holidays) and pure helpers `schoolCalendar`, `quarterOf`, `studySlots`, `quarterHours` | `api/calendar.ts`, `GET /calendar?year=` |
| Lesson models 5E, 3C + 1E, PEM·А, PEM·Б (Kyrgyz texts, stage hints, timings) | `lesson-models.ts` |
| `TeachingPlan.schedule` (lesson days per class), `TeachingPlan.origin` | `api/ktp.ts` |
| Issue `quarter_hours_short { quarter, planned, need }` — needs `schedule` | `api/ktp.ts` |
| `PATCH /ktp/:id` `remove: uid[]`, `insert: [{ afterUid, title, … }]`; `rows[].uid` as a guard | `api/ktp.ts` |
| `POST /ktp/:id/schedule` — dates from lesson days, holidays skipped; `mode: empty / all`; `assessments` adds СОР/СОЧ and splits big topics | `api/cabinet.ts` |
| `POST /ktp/from-standard` — a КТП without a textbook (the assistant drafts chapters from the subject standard) | `api/cabinet.ts` |
| `GET / PUT /ktp/:id/lessons/:uid` — lesson content (model, stages, goals, materials) | `api/cabinet.ts` |
| `POST /ktp/:id/lessons/:uid/conducted` — mark a lesson taught in a class | `api/cabinet.ts` |
| `POST /ktp/:id/lessons/:uid/assist` — `materials` / `ask` / `draft` | `api/cabinet.ts` |
| `GET /ktp/:id/lessons/:uid/slides?class=` — the lesson's .pptx | endpoints |
| `GET /teacher/agenda?from&to` — lessons by date and «Требует внимания» | `api/cabinet.ts` |
| `Me.defaultLessonModel`, `Me.region`, `Me.schoolName`; `PATCH /me { defaultLessonModel }` | `api/auth.ts` |
| `Student.lastSeenAt` | `api/classes.ts` |
| `AssignmentCreateRequest.title`, `.lesson { planId, uid }` | `api/classes.ts` |

## Server notes

- Lesson content is a table of its own (`LessonContent`, unique
  `(planId, uid)`), so autosaving a lesson never bumps the КТП version. It is
  deleted with its plan; a removed row's content is deleted with the row.
- `GET /ktp/:id/lessons/:index/plan` and `/plans` fill the .docx from the
  saved content when there is some (model stages, goals, ticked materials as
  an appendix); empty fields use the model's hints.
- The agenda reads the teacher's plans once per request; `today` is
  Asia/Bishkek.
- `assist` shares the tutor's provider, daily budget and rate limit
  (`budgetKey`), 30 requests per teacher and hour.
