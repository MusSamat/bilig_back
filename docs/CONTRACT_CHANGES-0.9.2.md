# Contract 0.9.2: a preliminary КТП from a textbook's contents

Contract `@bilig/content-model` and `@bilig/permissions` 0.9.1 → **0.9.2**
(additive). A teacher gets a draft КТП in a minute instead of typing it: from
a Bilig textbook, or from their own book's contents («Мазмуну»). No dates —
every teacher's timetable differs; they fill them in (or upload their own КТП).

## 1. Reading a book's contents — `POST /ktp/contents`

Body: `fileName` and exactly one source, prepared in the browser:

| Source | When | Who reads it |
|---|---|---|
| `pages: string[]` | a PDF with a text layer (text of the first 12 and last 8 pages) | the contents parser — no model, free |
| `docx` (base64) | a .docx with the contents | the contents parser |
| `images: string[]` (+ `imagePages`) | a scanned PDF (the same pages rendered to JPEG) or photos of the contents pages | the AI assistant (`deepseek-flash` reads images; ≤ 1 024 tokens a page, ≈ $0.003 for 20 pages) |

Text the parser cannot read as contents also goes to the model. The parser
knows chapter headings («I ГЛАВА. …», «Глава 2», «3-бөлүм», «Chapter 1»),
numbered lines with the page at the end («§ 4. … ..... 17», «4.1 … 17»),
wrapped titles, the introduction, chapter tests («тесттик тапшырмалар»,
«Текшерүү иши», «Контрольная работа»), lab works and appendices.

Response: `draft` (TextbookDraft: title, grade, language, subject, chapters →
lessons with number, kind `lesson | review | extra`, pages `{from, to}` — a
lesson ends where the next line starts — and the matched Bilig `topicKey`),
`source` (`text` | `assistant`), `contentsPages` and `warnings` (`no_pages`,
`pages_order`, `no_lessons`). The teacher checks and edits the draft.
Images without the online assistant → 503 `tutor_unavailable`; 15 readings
per teacher and hour; the daily token budget applies.

## 2. The КТП — `POST /ktp/from-textbook`

Body: `textbookKey` (a catalog textbook) **or** `draft` (the checked
contents), `hoursPerWeek` (1–10), `weeks` (default `SCHOOL_WEEKS` = 34),
optional `lang`, `year` (for the title), `classes` (labels for the date
columns), `subjectKey` (the chapters of one subject of an integrated book).

The plan (a normal TeachingPlan — editable, lesson plans download as before):

1. Every § in book order; a lab work right after the last lesson of its topic
   (a «Лабораториялык иштер» chapter is spread over the chapters); the chapter
   test («Текшерүү иши: «…»») closes each chapter.
2. Fitted to hoursPerWeek × weeks lessons:
   - too many → neighbouring § of a chapter are joined, the shortest pair (by
     pages) first («§ 4–5. …»), at most 3 in a lesson, then 5 for one lesson
     a week; tests and lab works are never joined;
   - room left → an analysis lesson after each test, a final review, then
     problem solving lessons spread by chapter size.
3. Homework = the § and its pages («§ 6, 22–23-беттер»), the Bilig topic of
   the lesson is linked, dates are empty.

A class column without any date is now one `date_missing` **info** issue for
the class (dates to be filled in), not an error per lesson.

## 3. Any КТП as .docx — `GET /ktp/:id/docx`

Landscape A4 in the usual school layout: heading (school, subject, grade,
year, «Жумасына 2 саат, бардыгы 68 саат», teacher), one table «№ · Сабактын
темасы · Саат · Датасы (a column per class) · Үй тапшырма · Эскертүү (Bilig
темасы)» with a row per chapter «… (12 саат)» and the total. The КТП parser
reads it back (ky, ru): download, edit in Word, upload again.

## Providers

`GenerateRequest.images` (data URLs): DeepSeek sends them as `image_url`
parts of the user message (`detail: high`), Anthropic as `image` blocks.
