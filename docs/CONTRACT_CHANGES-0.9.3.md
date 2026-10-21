# Contract 0.9.3: the book library

Contract `@bilig/content-model` and `@bilig/permissions` 0.9.2 → **0.9.3**
(additive). Every school book is saved once in Bilig with everything we need
later; teachers just choose the book of each class they teach.

## Staff (admin)

1. `POST /admin/books` — grade, language, subject, page count (+ title,
   part) → a book `uploading`.
2. `POST /admin/books/:id/pages` — up to 6 pages per request, each a page
   image (JPEG / PNG / WebP data URL, ≤ 1.5 MB) or its text (a PDF with a
   text layer). The browser renders the PDF; the server never gets the PDF.
   Images are kept in storage (`books/<id>/p0001.jpg …`): the book can be read
   again later with a better model. PDF page 1 becomes the cover.
3. `POST /admin/books/:id/process` (`from`: a stage to redo) → `queued`. The
   background worker reads the book (below); the list shows the stage and
   its progress, the tokens and the cost.
4. `GET /admin/books/:id` → the book and its §; `PATCH` fixes the meta and any
   §; `POST …/cover` sets a cover; `POST …/publish` (content.publish) makes it
   visible to teachers; `DELETE` archives it. Every step is journaled
   (`book.*`, group content).

## The reading (services/books.ts, domain/book-read.ts)

| Stage | Model | Result |
|---|---|---|
| pages | `BOOK_MODEL` (deepseek-flash, vision), `BOOK_OCR_EFFORT=none` — transcription needs no reasoning | per page: printed numbers (two for a spread), kind (cover, contents, …), headings with § numbers, all text, highlighted terms, formulas |
| contents | the contents parser; the model (`BOOK_ANALYSIS_EFFORT`) when it cannot read them; else the § headings found on the pages | chapters → § with printed pages; § linked to Bilig topics of the grade |
| sections | thinking model, `BOOK_ANALYSIS_EFFORT=high`, on the text of the §'s own pages | summary, objectives, key terms with the book's definitions, formulas, quantities, facts, experiments, the questions after the §, keywords for linking future topics |
| book | the model, low effort | title, authors, publisher, year, volume, a summary |

The worker leases one book (10 min), works ≤ 4 min per tick, saves every
page / § as it goes and releases it — a restart or a second API instance
resumes, never repeats. A failed page batch is retried (3 times); the
provider out of balance, offline or the daily cap (`BOOK_DAILY_TOKEN_BUDGET`,
30M tokens) pauses the book for 15 min with the reason in `error`.
Rough cost of a 90-page book: ≈ $0.25–0.40.

## Teachers

- `GET /books?grade&subjectKey&lang`, `GET /books/:id`, `GET /books/:id/cover`
  — published books only.
- `PATCH /classes/:id { books: { phys: <bookId> | null } }` — the book of a
  subject of the class (`SchoolClass.books`); only a published book of that
  subject.
- `POST /ktp/from-textbook { bookId, hoursPerWeek, … }` — without an own КТП
  the system's КТП comes from the class's book (§ with pages and topics). A
  teacher's own КТП stays the main one.

## Shipped books

`content/books/<key>/book.json` (+ `cover.jpg`) are imported on start as
published books, once (a book already in the database is never
overwritten). The first: «Физика, 7-класс», Э. М. Мамбетакунов (Бишкек,
2009, Kyrgyz) — every § read from the scan; «Физика, 7 класс», Э. Мамбетакунов,
Б. Б. Мурзаибраимова («Учкун», 2023, Russian) — read from its text layer.

## Migration

`20261023100000_contract_0_9_3`: `Book`, `BookPage`, `BookSection`,
`Class.books`.
