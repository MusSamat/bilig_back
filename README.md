# bilig_back

API for **Bilig**, a data-driven 3D STEM learning platform for schools of
Kyrgyzstan (ky / ru / en). The client is the separate repo
[`bilig_ft`](../bilig_ft). The specification is [`docs/TZ.md`](docs/TZ.md).

Stack: Node 20, Fastify 5, TypeScript (strict), Zod, Prisma 6 + PostgreSQL 16,
Redis 7 (optional), argon2id, JWT (jose), pino JSON logs, pdfkit / pptxgenjs,
Anthropic SDK (tutor).

## Layout

```
src/
  app.ts               Fastify app: helmet CSP, CORS, cookies, trace ids, problem+json, auth hook
  main.ts              entrypoint (config → deps → app → listen; scheduled publishes, 30-day purge)
  bootstrap.ts         dependency wiring (repository, limiter, mailer, storage, tutor provider)
  config.ts            env parsing (see .env.example)
  http/                route() helper over the contract ENDPOINTS table, auth context, errors
  domain/              pure logic: passwords, TOTP, JWT, masking, CSV, XLIFF, diff, tutor prompt/citations
  repo/                Repository interface, MemoryRepository, PrismaRepository, contract test suite
  services/            content/catalog, publishing + checklist, workflow, sessions, seed,
                       rate limits (Redis | memory), mailer, object storage, audit, tutor provider/settings
  modules/             auth, me, catalog, learning, classes, tutor, decks, ktp, admin/*
  ktp/                 КТП → lesson plans: safe .docx reader, КТП parser/checks, topic matching, plan content + .docx
  export/              PPTX / PDF decks and login cards (embedded Noto Sans: Ү Ө Ң)
prisma/                schema.prisma + migrations
packages/              shared contract (vendored, byte-identical in bilig_ft)
  permissions/         @bilig/permissions — RBAC matrix with scope
  content-model/       @bilig/content-model — content schemas; `/api` = ENDPOINTS + DTOs
content/               content data (catalog.json with textbooks, packages/*.json built from content/src)
data/leaked-passwords.txt   bundled leaked-password list (≥10 chars, from SecLists)
assets/fonts/          Noto Sans (OFL)
assets/templates/      official lesson-plan form, tagged for docxtemplater (provenance in its README)
```

`packages/*` is the **shared contract**. Make every change in both repos at the
same version and check that `npm run contract:hash` prints the same value (TZ §7).

## Run

```bash
npm install                 # also runs `prisma generate`
cp .env.example .env        # set JWT_SECRET / PSEUDONYM_SECRET (openssl rand -hex 32)
npm run db:up               # docker compose: postgres:16 → localhost:55433, redis:7 → localhost:56379
npm run db:migrate          # prisma migrate deploy
npm run db:seed             # import content/** as published TopicVersions + Builds
npm run start:dev           # http://localhost:3000/api/v1/health
```

`npm start` and the seed scripts read `./.env` (git-ignored; real env vars win), e.g. `DATABASE_URL=postgresql://bilig:bilig@localhost:55433/bilig`.

No Docker? `STORAGE=memory npm run start:dev` keeps everything in memory and
loads `content/**` on boot (data is lost on restart).

The compose project uses its own containers (`bilig_postgres`, `bilig_redis`)
and ports 55433 / 56379, so it does not collide with other local databases.

## Try it locally

A **dev-only** demo dataset lets you try the real app end to end
(`src/services/demo-seed.ts`). It is idempotent: it does nothing if
"Bilig Demo School" already exists, and it refuses to run when `NODE_ENV=production`.

```bash
STORAGE=memory DEMO_SEED=1 npm run start:dev   # in memory: content + demo data on every boot
# or, with PostgreSQL:
npm run db:seed && npm run db:seed:demo        # once; or set DEMO_SEED=1 to run it at startup
```

It creates "Bilig Demo School" (Bishkek), licensed for every live subject and
grades 6–11 for one year, a class **7А** (grade 7) and an assignment on the
animal-cell topic (tour + quiz, due in 7 days). The accounts are:

| Role | Login | Password / PIN |
|---|---|---|
| School admin | `admin@demo.bilig.kg` | `bilig-demo-2026` |
| Teacher (e-mail verified, teaches 7А) | `teacher@demo.bilig.kg` | `bilig-demo-2026` |
| Students (Айбек Асанов, Айпери Токтогулова, Нурсултан Жумабеков, Мария Иванова, Дмитрий Ким) | class code `DEMO77`, then pick a name | PIN `1234` |
| Superadmin | `super@demo.bilig.kg` | `bilig-demo-2026` + TOTP |

The admin audience requires TOTP for a superadmin, so the seed enrols one
and prints its secret and `otpauth://` URL. Add it to an authenticator app
(scan the URL as a QR code or type in the secret). Later runs print the
stored secret again. With `STORAGE=memory`, every restart creates a new secret,
so you have to enrol again. On the client audience the superadmin logs in
without TOTP.

## Scripts

| Script | What it does |
|---|---|
| `npm run start` / `start:dev` | run the API (tsx / watch) |
| `npm test` | all unit and route tests (vitest, in-memory repository, no Docker needed) |
| `npm run test:coverage` | the same, with v8 coverage |
| `npm run test:db` | the repository contract suite against PostgreSQL (`TEST_DATABASE_URL`; applies migrations first) |
| `npm run typecheck` | `tsc --noEmit` for the app and the contract packages |
| `npm run db:up` / `db:migrate` / `db:migrate:dev` / `db:seed` | database lifecycle |
| `npm run db:seed:demo` | DEV ONLY: demo school, accounts, class and assignment (see [Try it locally](#try-it-locally)) |
| `npm run tutor:eval` | golden-set evaluation of the assistant through the real request path (language, on/off topic, length, citations, latency, cost); uses `DEEPSEEK_API_KEY` when set, else the offline `dev` provider. `-- --topics=speed --langs=ky --out=report.md` |
| `npm run contract:hash` | sha256 of `packages/permissions` + `packages/content-model`; must equal bilig_ft's |

### Testing strategy

`npm test` runs against `MemoryRepository`, so it is hermetic and fast. The
same repository contract suite (`src/repo/repo.contract.ts`) also runs against
`PrismaRepository` with `npm run test:db` (CI runs both, with a PostgreSQL 16
service). Route tests use `fastify.inject()`, a manual clock (lockouts,
expiries, schedules) and a mocked tutor provider.

## Environment

All variables are documented in [`.env.example`](.env.example). The important ones:

| Variable | Notes |
|---|---|
| `DATABASE_URL`, `STORAGE` | PostgreSQL via Prisma (`prisma`) or `memory` |
| `REDIS_URL` | rate limits and the tutor budget; unreachable → in-memory fallback (single instance only) |
| `JWT_SECRET`, `PSEUDONYM_SECRET` | required in production |
| `CORS_ORIGIN` | comma-separated client/admin origins (credentials allowed) |
| `TUTOR_PROVIDER` | `deepseek` (in use), `anthropic` (kept), `dev` or `none`. Unset: `deepseek` with `DEEPSEEK_API_KEY`, else `dev` in development, else `none` (tutor answers 503). `dev` answers and generates from the package itself, without an LLM, and is refused in production |
| `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL` | DeepSeek (OpenAI-format API, `https://api.deepseek.com`, model `deepseek-flash`) |
| `DEEPSEEK_CHAT_THINKING`, `DEEPSEEK_GENERATE_EFFORT` | thinking for chat answers (default off: fast first token) and the reasoning effort for generation (`none`/`low`/`high`/`max`, default `none` since 0.9.1: reasoning is billed as output and was half the bill) |
| `TUTOR_MODEL`, `TUTOR_FALLBACK` | the primary model (default per provider); an optional failover provider (`anthropic` / `deepseek`) |
| `ANTHROPIC_API_KEY` | Claude, only when chosen with `TUTOR_PROVIDER=anthropic` or `TUTOR_FALLBACK=anthropic` |
| `TUTOR_DAILY_TOKEN_BUDGET` | daily token budget; once spent the tutor answers 503 |
| `BOOK_MODEL`, `BOOK_OCR_EFFORT`, `BOOK_ANALYSIS_EFFORT`, `BOOK_DAILY_TOKEN_BUDGET` | the book library worker: the model (deepseek-flash, reads page images), reasoning for page transcription (default `none`) and for the § analysis (default `high`), a daily token cap (30M) — see docs/CONTRACT_CHANGES-0.9.3.md |
| `TUTOR_ANSWER_CACHE` | `1` (default): one shared answer per topic version, language and self-contained question (starter or first question); repeats cost no tokens. `0` turns it off |
| `TUTOR_PRICE_INPUT` / `TUTOR_PRICE_INPUT_CACHED` / `TUTOR_PRICE_OUTPUT` | USD per 1M tokens (defaults 0.15 / 0.003 / 0.6): the cost in the `tutor.usage` log line and in `npm run tutor:eval` |
| `MAIL_TRANSPORT` | `console` prints verification / reset / invite links |
| `DEMO_SEED` | `1` loads the demo dataset at startup (dev only; refused in production) |
| `AUTH_FIXED_OTP` | TEMPORARY: every one-time code (e-mail registration, WhatsApp phone codes) is this 6-digit value; phone codes are not sent (startup warning) |
| `AUTH_FIXED_TOTP` | TEMPORARY (test period): the admin panel accepts this 6-digit value as the 2FA code for every admin, enrolled or not; real authenticator codes still work; each such sign-in is marked `totp: fixed` in the audit log (startup warning). Delete before real use |
| `OTP_SENDER` | phone codes (0.7.0): `fixed` (needs `AUTH_FIXED_OTP`), `console` (prints «WhatsApp → +996…»; refused in production) or `whatsapp` (stub, refused at start). Unset: `fixed` with `AUTH_FIXED_OTP`, else `console` outside production; production without a working sender refuses to start |
| `ADMIN_TOTP_DISABLED` | `1` skips the TOTP code on admin sign-in (dev only; refused in production — TZ §6 requires 2FA) |

## Architecture notes

- **Contract first.** Every route is registered from `ENDPOINTS` in
  `@bilig/content-model/api`. Bodies and queries are parsed, and responses are
  serialised, with its Zod schemas, so the server cannot drift from the client.
- **RBAC only on the backend**, through `@bilig/permissions` (`can()` with
  school / subject / class scope). Teachers manage only the classes they teach;
  school admins manage every class of their school. Subject scope ids are
  subject keys (`bio`); dictionary entries belong to a subject by key prefix
  (`bio.nucleus`).
- **Auth (TZ §6).** argon2id for passwords and PINs; ≥10 characters plus a
  bundled leaked-password list; JWT access tokens (15 min, `aud` = `client` |
  `admin`, chosen with the `X-Bilig-Audience` header on login/refresh); opaque
  refresh tokens in `HttpOnly; Secure; SameSite=Lax` cookies scoped to
  `/api/v1/auth` (30 days sliding, students 8 hours fixed), rotated on every
  refresh, with the whole family revoked on reuse; TOTP required for
  manager/superadmin (and legacy author/editor) on the admin audience (enrol via `POST /me/2fa`);
  PIN lockout of 15 min after 5 bad tries; identical answers for an unknown
  e-mail and a wrong password; rate limits on login, reset, class codes and the
  tutor. Logins, role changes, publishes and student-data access go to the
  append-only audit log.
- **Roles, support, journal (0.8.0).** A `manager` holds the permissions SuperAdmin
  ticked (`StaffProfile.permissions`; the matrix is the ceiling), built into the
  principal on every request. Staff sign in only at /admin (a teacher there gets
  403 `use_teacher_login`). Support sessions (`ImpersonationSession`) give a
  15/30-min client token with `act` = the staff member; view mode is read-only
  (403 `support_read_only`), credentials/2FA/sessions are closed in every mode
  (403 `support_forbidden`). Everything goes to `AuditEvent`: monthly-partitioned,
  a trigger rejects UPDATE/DELETE, rows are hash-chained by `audit_event_append()`
  under an advisory lock, `GET /admin/journal/verify` walks the chain. `main.ts`
  runs `audit_event_maintain()` daily (partitions 3 months ahead, 36-month
  retention by dropping partitions) and closes expired support sessions.
  The legacy `AuditLog` is read only; `GET /admin/audit` projects the journal.
- **Phone-first teachers (0.7.0).** A teacher account is a Kyrgyz mobile number
  (`User.phone`, E.164, unique) + password. `POST /auth/otp/start` sends a
  6-digit code to WhatsApp through the `OtpSender` port
  (`src/services/otp-sender.ts`); codes live in `PhoneOtp` (10 min, 5 wrong
  tries burn, resend after 60 s, limits per IP and per number) and the same
  answer is given for taken / unknown numbers. `POST /auth/otp/verify` trades
  the code for a single-use 15-minute token bound to number + purpose;
  `register/complete` creates the account, a personal school («Моя школа»
  until named) and an empty trial licence; `password/set` resets and revokes
  other sessions. `POST /auth/login` takes `phone` or `email`; the admin
  audience stays e-mail + TOTP (a phone there is 400 `email_required`).
- **Content.** Relational tables plus JSONB documents (TopicVersion.doc). The
  client reads only built packages (Build). Publishing assembles the package
  from the tables, runs the automatic checklist (schema, translations, budgets,
  alt text), hashes it and moves the topic's published pointer. Catalog
  responses are localised by `Accept-Language` with the ky → ru → en chain.
  A topic is open to guests when `topic.demo` is true; other topics need an
  active school licence for the subject and grade.
- **Tutor.** `POST /api/v1/tutor/ask` streams SSE (`token`, `citation`, `done`)
  or returns JSON with `Accept: application/json`. The prompt is built on the
  server from the published package only; the question is wrapped as user
  content; names, phones and e-mails are masked; no user ids are sent; stop
  topics and injection attempts are refused without calling the model; limits
  apply per IP, role and school, plus a daily token budget.
  Since 0.4.0 the request carries a context envelope (focus concept, sample,
  process step, a quote the teacher selected, and a quick action: explain,
  simpler, example). Keys are resolved against the package; the quote is
  masked and treated as data. Off-topic answers end with a `suggestions` event
  of follow-up questions about the topic.
- **Generated examples and questions.** `POST /api/v1/tutor/generate` serves
  «Ещё примеры» / «Ещё вопросы» from a pool (approved items first, reported
  ones hidden) and tops it up with the model through structured outputs. Every
  item is validated before it is stored or shown. Teachers rate items
  (`/tutor/generated/:id/feedback`), and editors review them in
  `/admin/generated` (approve, dismiss, or promote into the content).
- **Logs.** pino JSON with a trace id (`X-Request-Id` / `traceparent`); no
  tokens, cookies, bodies or query strings.

## Status / not yet implemented

- Offline mode is out of scope for now. `POST /sync` exists (idempotent, deduplicated), but
  signed offline results and offline session trust (TZ §6) are not implemented.
- Exports run synchronously (no job queue yet); WebP snapshots show as placeholders in PDFs.
- Asset processing (meshopt, KTX2, thumbnails) returns a stub report until `bilig_worker`
  exists; local storage has no presigned multipart upload (the S3/MinIO adapter is pending;
  `POST /admin/assets/:id/complete` calls its `completeMultipart` once it exists).
- Contract 0.3.0 changes (admin/client requests → resolutions): [`docs/CONTRACT_CHANGES-0.3.0.md`](docs/CONTRACT_CHANGES-0.3.0.md).
- Contract 0.4.0 (assistant in the classroom: context, quick actions, generation, review): [`docs/CONTRACT_CHANGES-0.4.0.md`](docs/CONTRACT_CHANGES-0.4.0.md).
- LearningEvent month partitioning, OpenTelemetry and Sentry are not wired up yet.
