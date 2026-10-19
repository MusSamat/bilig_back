# Templates

## `lesson-plan.docx` — official 45-minute lesson plan form (сабак планы)

**Source.** `templates/plan_template.docx` of the «Bilig KTP tool» reference
prototype (Python, received 2026-10-19). It is the lesson-plan form used in
Kyrgyz schools (landscape A4, Times New Roman 12; header block, goals table
«Сабактын максаттары / Күтүлүүчү натыйжалар», key and subject competences,
the 7-stage «Сабактын жүрүшү» table, «Колдонулган булактар»). The sample
lesson filled into it (a literature lesson) was removed.

**What was changed** (a one-off script over `word/document.xml`; no Word round trip):

- Layout kept as is: page size/orientation/margins, styles, fonts, borders,
  table grids and column widths, paragraph and run properties, footer with page numbers.
- Text runs replaced by docxtemplater tags. Values: `{classLabel}`, `{date}`,
  `{teacher}`, `{subject}`, `{lessonType}`, `{topic}`, `{methods}`, `{target}`,
  `{task}`, `{materials}`, `{goal1..3}`, `{outcome1..3}`, `{pk1..3}`,
  `{draftNote}`; loops `{#stages}…{/stages}` (one table row per stage: `name`,
  `minutes`, `teacher`, `student`, `kc`, `pk`, `assessment`) and
  `{#sources}{.}{/sources}` (one numbered paragraph per source).
- The form's own labels are tags too (`{L.subject}`, `{L.flow}`, …), filled from
  the ky / ru / en dictionary in `src/ktp/plan-docx.ts`, so every language
  renders from this one file.
- The whole body is wrapped in `{#plans}…{@pageBreak}{/plans}`: one plan or a
  range of plans (a page break between them) render the same way.
- Removed: the sample teacher's name and lesson text, `w14:paraId`/`textId`
  (must stay unique after loops), proofing marks, bookmarks, Google Docs /
  WPS custom XML parts (`customXml/*`, `docProps/custom.xml`) and an external
  hyperlink relationship; `docProps/core.xml` author set to «Bilig».

Multi-line values use `\n` (rendered as line breaks, `linebreaks: true`).
To change the layout, edit the .docx in Word keeping the tags intact (a tag
must stay within one run); `src/ktp/__tests__/ktp.test.ts` renders every
language and checks the structure (7 stages totalling 45 minutes, goals
table, labels, no leftover `{…}`).
