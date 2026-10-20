# Contract 0.9.0: the assistant on DeepSeek — a reusable prompt shell, cheaper requests

Contract `@bilig/content-model` and `@bilig/permissions` 0.8.0 → **0.9.0**. Additive.

## 1. Provider

The assistant runs on **DeepSeek** (`deepseek-flash`, OpenAI-format API
`https://api.deepseek.com`; `TUTOR_PROVIDER=deepseek`, `DEEPSEEK_API_KEY`).
Claude stays in the code, used only when chosen explicitly. Why not
DeepSeek's Anthropic-compatible endpoint: it takes only `claude*` model names
and supports `output_config.effort` alone — no JSON output for generation.

- Chat answers stream with thinking **off** (fast first token in class;
  `DEEPSEEK_CHAT_THINKING=1` turns it on). The chain of thought is never shown.
- Generation («ещё примеры / вопросы») uses JSON object mode with thinking at
  `DEEPSEEK_GENERATE_EFFORT` (default `low`; reasoning is billed as output).
- `content_filter` → the polite refusal; 401/402/429/5xx and
  `insufficient_system_resource` → «assistant unavailable» (the client keeps
  its offline index). `TUTOR_FALLBACK` (opt-in) retries on another provider
  only when nothing was streamed yet.

## 2. The prompt is a reusable shell

```
shared rules (code)  →  subject guide (content, once per subject)  →  platform extras
→  topic material (generated from the package)  ‖  messages: short history + the question
```

- `Subject.assistantGuide` (curriculum.json): how to answer in this subject
  (physics: quantity, symbol, unit, formula, a worked number; chemistry:
  balanced equations, simulation-only safety; biology: no medical advice …).
- Everything before `‖` is identical for every request of a topic+language,
  and the rules + subject guide are identical for every topic of a subject, so
  DeepSeek's context cache serves them (cache hit $0.003/M vs $0.15/M).
- Language rules per answer language; Kyrgyz: literary Kyrgyz with ө ү ң, not
  Kazakh, not Russian, the topic's own terms.

## 3. Starter questions per topic

`Topic.starters` (≤ 6, ky/ru/en): written per topic (4 each for all 44
topics). `suggestQuestions` shows them first, then questions built from the
topic's content — a common mistake («Чын эле…?»), a real-life example, a
process — and asks «where is it / what is it made of» only about physical
things (`PHYSICAL_KINDS`), never about a speed or a force.

## 4. Cost and quality (audit, before → after)

| | Before | After |
|---|---|---|
| System prompt, median / max tokens | 4,298 / 6,725 | ≈ 2,600 / ≤ 5,200 (CI budget) |
| Glossary in every request | the subject's ~63 terms × 3 languages | only the terms the topic uses, answer language |
| History | 8 messages, up to 4,000 chars each | 6 messages, ≤ 600 chars each, ≤ 2,400 total |
| Answer cap / generation cap | 700 / 2,000 tokens | 450 / 1,200 tokens |
| «Do not repeat» list in generation | up to 60 × 200 chars | 25 newest × 140 chars (the server still dedups the whole pool) |

Generated items are validated by language (Kyrgyz word/ending markers vs
Russian, no Kazakh letters; Russian without Kyrgyz letters; English without
Cyrillic), size (title ≤ 80, text ≤ 400, question ≤ 260, option ≤ 120),
2–4 options (2 only as true/false), no «all/none of the above», and a STEM
field for STEM examples.

`npm run tutor:eval` runs a golden set through the real request path and
reports language, on/off-topic behaviour, length, citations, latency and cost.
