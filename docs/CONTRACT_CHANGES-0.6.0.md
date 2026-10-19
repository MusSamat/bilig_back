# Contract 0.6.0: teachers register themselves

Contract `@bilig/content-model` and `@bilig/permissions` 0.5.0 → **0.6.0**.
Additive: older clients keep working.

A teacher signs up without an invite, confirms the e-mail with a 6-digit
code and lands in the teacher cabinet, ready to create classes, give
assignments and use КТП lesson plans for the subjects and grades they teach.

## 1. Registration

| Endpoint | Body | Response |
|---|---|---|
| `POST /auth/register` (v0.2.1, extended) | `{ email, password, displayName, locale?, teaching?: { subjects, grades }, schoolName?, region? }` | `{ ok, expiresIn, resendAfter }` |
| `POST /auth/register/verify` | `{ email, code }` | `TokenResponse` (signed in, client audience) |
| `POST /auth/register/resend` | `{ email }` | `{ ok, expiresIn, resendAfter }` |

- The account is `pending` until verified and cannot sign in.
- The same answer whether or not the e-mail is taken (no enumeration). A taken
  address gets a «you already have an account» mail instead of a code.
- The code: 6 digits, valid 15 minutes, 5 wrong tries burn it, resend after
  60 s; rate limits per IP and per e-mail. The v0.2.1 link (`POST
  /auth/email/verify`) keeps working.
- **Temporary fixed code**: with `AUTH_FIXED_OTP=012345` in the server env,
  the code is always that value (no mail server yet). The server logs a
  warning at start. Remove the variable to send real random codes by e-mail.

## 2. What verification creates

- A personal school (`origin: self`): named `schoolName`, or after the
  teacher; region from the request.
- Grant `teacher` on that school → `class.manage`, `assignment.manage`,
  `lesson.plan`, `topic.view` work as for invited teachers.
- A **trial licence** for `teaching.subjects` × `teaching.grades`, from now
  for `TRIAL_DAYS` (server env, default 30), 40 seats.

## 3. Profile

- `GET /me`: `teaching` (self-registered teachers) and `licenses` (active
  licences of the user's schools: school name, subjects, grades, dates, `trial`).
- `PATCH /me { teaching }`: a self-registered teacher changes what they
  teach; the trial licence follows (dates unchanged). Not allowed for
  teachers of an admin-created school (403).

## 4. Classes

`Class.subjectKey?` — the subject the teacher teaches in the class; on create
and patch. Must be one of the school's licensed subjects when set.

## 5. Ready-made presentation of a topic

`GET /topics/:key/deck?lang=ky&format=pptx|pdf` (same access as the topic:
demo topics for everyone, others by licence) returns the topic's presentation,
built on the server from the published package — no teacher work needed:

1. title and the lesson goal, objectives and the textbook § / pages;
2. the samples as 3D images (rendered thumbnails);
3. the lesson steps (the tour), each with its image and the teacher note in
   the speaker notes;
4. key concepts; processes with their steps and equations;
5. examples from STEM and everyday life;
6. questions for the class (answers in the speaker notes);
7. sources and rights.

Cached per package hash × language × format. `Content-Disposition` names the
file after the topic. The `produces` media type is PPTX; with `format=pdf`
the response is `application/pdf`.
