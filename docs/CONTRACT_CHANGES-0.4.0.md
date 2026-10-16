# Contract 0.4.0: the assistant in the classroom

Contract `@bilig/content-model` and `@bilig/permissions` 0.3.0 → **0.4.0**.
Everything is additive. Older clients keep working: new request fields are
optional, and a client that does not know the new `suggestions` stream event
skips it.

The users are teachers who explain a topic to the class on a screen. That
drives three choices:

- Answers are written for the students. The system prompt says so.
- Generated material is seen by the teacher before the class sees it, and is
  always labelled as AI-made.
- Generated questions are practice for the class. Nothing about answering
  them is stored.

Migration: `prisma/migrations/20261016120000_contract_0_4_0` (new
`GeneratedContent` table).

## 1. Context envelope and quick actions: `POST /tutor/ask`

New optional request fields:

| Field | Meaning |
|---|---|
| `context.mode` | `explore`, `lesson`, `process`, `compare` or `quiz` |
| `context.sampleKey` | sample on the stage (`topic.samples[].key`) |
| `context.processKey`, `context.stepIndex` | process and step on screen |
| `context.quote` | `{ text ≤ 500, source?, conceptKey? }`: text the teacher selected on the page |
| `intent` | `ask` (default), `explain`, `simpler` or `example` |

How the server uses them:

- Keys are resolved against the published package. Unknown keys are ignored,
  and titles always come from the package, never from the client.
- The quote is user content, like the question. PII is masked, it is checked
  for stop topics and injection, and it is sent to the model inside
  `<selection>` tags.
- An intent becomes a fixed, server-written task line. It is used only when
  there is a quote.
- When there is no `conceptKey`, the quote's `conceptKey` sets the focus. This
  is how a short follow-up like «а сколько там атомов?» is understood.

New stream event: `{ type: 'suggestions', items: string[] ≤ 5 }`.
- It is sent after an off-topic or unanswerable question, and after a refusal.
- The items are follow-up questions about the focus concept or the topic.
- JSON mode returns the same list as `suggestions`.
- `suggestQuestions()` in the contract builds them. The client uses the same
  function for its chips, so the wording matches.

## 2. Generation: `POST /tutor/generate`

`{ topicKey, lang, kind: simple | stem | quiz, conceptKey?, count 1–5 (default 3), exclude: id[] }`
returns `{ kind, lang, examples[], quiz[], exhausted }`.

1. **Pool first.** Items are stored per (topic, concept, kind, language).
   - Approved items come first, then the best-rated.
   - A `new` item stops being served at its first report.
   - An `approved` item stops being served at three reports.
   - Dismissed and promoted items are never served.
   - Ids in `exclude` (already on screen) are skipped.
2. **Top-up from the model.** This happens only when the pool is short.
   - The system prompt is the same as for questions (material plus safety
     rules).
   - The task prompt lists the existing items, so they are not repeated.
   - The output is structured: JSON Schema via `output_config.format`.
3. **Validation.** An item is dropped unless all of these hold:
   - it is complete and within length limits;
   - it does not repeat the pool or the concept card;
   - for a quiz, it has 2–5 distinct options and the answer is one of them.

   Also:
   - `[[markers]]` and tags are stripped;
   - unknown concept keys are removed;
   - the number of rejected items is logged.
4. **Limits and budget.** These are the same as for `/tutor/ask`, and tokens
   count against the daily budget.
   - When the provider fails, the pool is still served.
   - With nothing to serve, the endpoint returns 503 `tutor_unavailable`.

Quiz items are single-choice, with option keys `a`–`d`. The answer is part of
the response, because the teacher reveals it to the class. Nothing is stored
about how the class answered.

## 3. Feedback: `POST /tutor/generated/:id/feedback`

The body is `{ vote: 'good' }` or `{ vote: 'bad', reason: wrong | unclear | inappropriate | off_topic }`.
- One vote is counted per user (or per IP for guests) per item for 90 days.
  Repeated votes are accepted and ignored.
- Counters are atomic, including the per-reason JSON in PostgreSQL.

## 4. Review queue: `GET /admin/generated`, `PATCH /admin/generated/:id`

- **Permission:** `content.draft.edit`, scoped by the topic's subject.
  Editors of other subjects see an empty list and get 404 on a patch.
- **List filters:** `status`, `kind`, `topicKey`, `lang`, `reported`.
- **List sorting:** `sort=createdAt|good|bad|served`, with `order`.
- **Patch:** `{ status: new | approved | dismissed | promoted, promotedTo? }`.
  `promoted` requires `promotedTo` (e.g. `item:<key>`, `concept:<key>`).
  Every change is audited as `generated.<status>`.

Promotion copies the item into the normal content through the existing
editors (item bank or concept examples), so translation and publishing follow
the usual workflow.

## 5. Shared helpers (`@bilig/content-model`, `assist.ts`)

All of these are pure functions used by the server, the client and the mock
API:

- `suggestQuestions`: follow-up questions about the focus concept or topic.
- `glossaryMatches`: offline «Перевести» for a selection.
- `groundedAnswer` and `groundedGenerate`: answers and items assembled only
  from authored content. They back `TUTOR_PROVIDER=dev`, so everything works
  without an API key.

## Configuration

`TUTOR_PROVIDER` is `anthropic`, `dev` or `none`.
- When it is unset: `anthropic` with a key, else `dev` in development, else
  `none`.
- `dev` is refused in production.
- `anthropic` without a key is a startup error.
