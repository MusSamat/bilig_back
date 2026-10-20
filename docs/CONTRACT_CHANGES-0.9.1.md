# Contract 0.9.1: generated examples remembered per teacher, grade ranges

Contract `@bilig/content-model` and `@bilig/permissions` 0.9.0 → **0.9.1**
(additive; old clients keep working).

## 1. One item per click, remembered per teacher

- The server remembers which generated items (simple / STEM examples,
  practice questions) every user got: table `GeneratedSeen (userId,
  generatedId, seenAt)`.
- `POST /tutor/generate` serves, in order: pool items this user has not seen
  (reviewed and well-rated first), and asks the model only when the user has
  seen every pooled item that suits the topic. The client now asks for
  `count: 1` per click («Ещё пример», «Ещё вопрос»); `count` still accepts 1–5.
- New `GET /tutor/generated?topicKey&lang&kind&conceptKey?` (permission
  `assistant.ask.online`): the items this user already got for the card, in
  the order first seen, plus `unseen` — how many pooled items are still new to
  them. No model call; a card shows them again after a reload. A guest gets an
  empty list. Items the user reported are not returned.

## 2. Grade ranges: one concept, several grades

- `GeneratedExample.grades` and `GeneratedQuizItem.grades` — optional
  `{ from, to }` (1–12): the grades the item suits («6–8 кл.» badge).
- The model proposes `gradeFrom` / `gradeTo` for every item; the server keeps
  the range honest: it always contains the topic's grade and reaches at most
  2 grades either way (`gradeRange`, `GRADE_SPREAD`).
- Sharing: an item about a concept is served to every topic that teaches that
  concept in a grade inside the range (speed in grade 7 and grade 8). A
  topic-level item, or one without a range, stays with its topic. Items of any
  grade still count as «do not repeat» for the model.

## 3. Cost of the assistant

- Provider usage carries `cachedInputTokens` (DeepSeek
  `prompt_cache_hit_tokens`, Anthropic `cache_read_input_tokens`);
  `TutorMessage.cachedTokens` stores it.
- One log line `tutor.usage` per model call: purpose, topic, input, cached,
  output tokens and `costUsd` at `TUTOR_PRICE_INPUT` / `_INPUT_CACHED` /
  `_OUTPUT` (USD per 1M tokens). `npm run tutor:eval` reports the cache hit
  rate and the real cost.
- Chat history sent to the model: the last question and answer only (was 6
  messages), at most 400 characters each. The system prompt (rules + the
  topic material) stays byte-identical for a topic and language, so the
  provider's prompt cache serves it to every teacher at the cache price.
- Compact chat material (−22 % median, ≈ 2.5k tokens): terse rules; the topic,
  every structure's description, values (no repeats), analogies and common
  mistakes with corrections, process titles and steps' titles. Dropped from
  chat: «related» links, fun facts, the goal line, step texts. Generation of
  examples keeps the full material.
- Shared answers (`TutorAnswer`, `TUTOR_ANSWER_CACHE=1` by default): a
  self-contained question — the first of a thread, or a starter / suggested
  question — without a selection is answered once per topic version
  (package hash), language, normalised question, quick action and screen
  context; repeats replay the stored text (with its citations) and cost no
  tokens. Refusals, off-topic replies and failed streams are never stored.

## Migration

`20261022100000_contract_0_9_1`: tables `GeneratedSeen`, `TutorAnswer`,
column `TutorMessage.cachedTokens`.
