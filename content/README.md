# Bilig content: authoring guide

All learning content is data. No code anywhere knows the name of a subject or
a topic (TZ §4 «Для масштаба»). To add a subject, a course, a topic, a concept
or a quiz question, you edit JSON in `content/src/` and run the build. You do
not touch any TypeScript.

## Layout

```
content/
  catalog.json               BUILD OUTPUT: groups, subjects, courses, units (server catalog base)
  packages/<topicKey>.json   BUILD OUTPUT: one validated ContentPackage per topic
  build.mjs                  assembles + validates packages from src/
  assets/<topicKey>/         binary files of a topic (GLB, thumbs/*.webp) + ASSET.json (licence, author, source)
  assets/CREDITS.md          attribution for every asset (CC BY text where required)
  src/                       AUTHORING SOURCES (edit these)
    curriculum.json          groups, subjects, courses, units, objectives
    concepts/<subject>.json  { "concepts": Concept[] }       the shared concept dictionary
    processes/<subject>.json { "processes": Process[] }      reusable processes (timeline/stoich/ode)
    glossary/<subject>.json  { "glossary": GlossaryTerm[] }  shipped in every package of that subject
    property-types/*.json    { "propertyTypes": PropertyTypeDef[] }  extends the built-in PROPERTY_TYPES
    topics/<topicKey>.json   { "topic": Topic, "items": Item[], "version"?: "1.0.0" }
```

The schemas are in `packages/content-model/src` (the shared contract, don't
edit it from here). Field-by-field, a source entity is exactly the schema
object: `Concept` in `concept.ts`, `Process` in `process.ts`, `Item` in
`item.ts`, `Topic` in `topic.ts`. Every localized string is
`{ "ky": "…", "ru": "…", "en": "…" }`.

`packages/` and `catalog.json` are generated files. Never edit them by hand,
because the next build overwrites them and the test fails when they are
stale. The server (`src/content-repo.ts`) reads only these outputs.

## Commands

```bash
npx tsx content/build.mjs                       # build + validate, write packages/ and catalog.json
npx tsx content/build.mjs --check               # build + validate, fail if outputs are stale (CI)
npx tsx content/build.mjs --only=water,methane  # validate just these topics, write nothing
npx tsx content/build.mjs --partial             # validate all topics, skip coverage checks, write nothing
npx vitest run src/content.test.ts              # content tests (validation, examples, catalog, freshness)
npx tsx scripts/seed-scale.mjs [outDir]         # TZ §10 scale data: 20 subjects / 2000 topics / 10 000 concepts / 5 langs
```

The build runs under `tsx` because it imports the TypeScript contract. It
prints `topics= concepts= processes= items= glossary= warnings= errors=` and
exits with code 1 on any error.

## What the build does

For each `topics/<key>.json`:

1. Resolves `unitKey → course → subject` from `curriculum.json`. The package
   also gets every objective of the unit.
2. Collects concepts from the dictionary: `topic.conceptKeys`, their
   `related`, the `conceptKey` of each process step, and comparison concept
   columns. Concepts pulled in only as neighbours keep just the `related`
   links that stay inside the package.
3. Adds the processes listed in `activities.processKeys`, the topic's items,
   the subject's glossary, and only the extra property types the package
   uses.
4. Writes a manifest: the scene asset and the sample thumbnails, plus a
   sha256 over the package. A manifest path `P` of topic `T` is the file
   `assets/T/P`: when it exists the manifest gets its real sha256 and size
   (and it must have an `ASSET.json` entry with `license`, `author` and
   `source`, TZ A-05; the files of one package must stay ≤ 5 MB). Missing
   files keep a placeholder (`sha256("pending:<path>")`, size 0) and the
   client renders the procedural scene instead. The server serves real files
   at `<filesBaseUrl><path>` (`/cdn/<packageHash>/<path>`, immutable). `builtAt` is fixed (env
   `SOURCE_DATE` overrides it), so builds are reproducible.
5. Runs `validatePackage`, which checks the schema and all cross-references.
   On top of that it applies the authoring rules below.

It also checks that every unit has at least one topic, that every `live`
subject has topics and that `soon` subjects have none. Keys must be unique
across files: concepts, processes, items and glossary ids.

## Authoring rules (enforced)

- Every topic and every concept has `examples.stem` (≥2 real STEM
  applications, each with `field`: `s` science, `t` technology,
  `e` engineering, `m` math) and `examples.simple` (≥2 everyday analogies a
  10–13-year-old gets right away). All of them are written in ky, ru and en.
- The quiz has ≥6 items. Use all 5 types: `single`, `multiple`, `match`,
  `find-on-model` (target in `conceptKeys`) and `numeric` (with `tolerance`
  and `unit`).
- The tour has 4–8 steps, each with `text` and `altText`. Steps should also
  have a `camera`, a `focus` and a `teacherNote`.
- Quantity props carry numbers, not text, with the unit from the property
  type or overridden with `unit`. Use `max` for ranges and `approx` for "≈".
- Shells (membranes, walls, faces, crust, atmosphere, electron shells) get
  `isContainer: true`, so they never steal clicks from what is inside them.

## Conventions

- Keys: concepts `<subject>.<name>` (`bio.nucleus`, `chem.water`); items
  `<subject>.q.<name>`; misconceptions `<subject>.m.<name>`; glossary ids
  `g-<subject>-<term>`; objectives `<unitKey>.o<n>` with a KR program code
  (`BIO-7.2.1`). The topic key is the URL slug and the file name.
- `topic.i18n` defaults to `{ ky: "machine", ru: "reviewed", en: "draft" }`.
  A native Kyrgyz reviewer flips `ky` to `reviewed`.
- Scene plugins and their params:
  - `gltf`: `asset: "<key>.glb"` (file `assets/<key>/<key>.glb`; without it the
    plugin builds a procedural scene from the same masks). Bind concepts with
    `overrides[key].nodes` (globs such as `Mito_*`) and `anchor`.
    Modes: `whole`, `section`.
  - `molecule`: `params.atoms[{id, element, position Å}]`,
    `params.bonds[{a, b, order}]`, or a `preset`. Nodes are named
    `Atom_<id>`, `Bond_<a>_<b>`, `Shell_<atomId>_<n>` and `Nucleus_<atomId>`.
    Modes: `ball-stick`, `spacefill`, `shells`.
  - `crystal`: `params.structure`, `latticeConstant` (nm), `cells`,
    `ions[{element, charge, radius}]`. Nodes are named `Ion_<El>_*` and
    `UnitCell`.
  - `geometry`: `params.solids[{id, type, …dimensions, position}]`. Nodes are
    named `<id>`, `<id>_Face_*`, `<id>_Edge_*` and `<id>_Vertex_*`. Modes:
    `solid`, `wireframe`.
  - `sim`: `params.model` (`pendulum`, `inclined-plane`, `dc-circuit`,
    `orbits`, `moon-phases`) plus numeric parameters. Nodes are named by
    part (`Bob`, `String`, `Block`, `Lamp`, `Planet_<name>`, …). Values in
    `ode` processes come from the engine's formulas, never from hand-drawn
    numbers.
- Tour `modes` use the plugin's mode group or id: `{ "view": "section" }`,
  `{ "rep": "spacefill" }`, `{ "shells": true }`.

## How to…

**Add a topic.** Create `src/topics/<key>.json` with a `topic` (unitKey,
scene, conceptKeys, overrides, samples, activities, examples) and its
`items`. Add any new concepts to `src/concepts/<subject>.json` and any new
processes to `src/processes/<subject>.json`. Run the build. That's it: the
catalog topic list comes from the packages.

**Add a subject.** In `src/curriculum.json`, add the subject (`key`, `title`,
`icon` from the UI sprite, `hue` 0–359, `group`, `order`,
`status: "soon" | "live"`), a course (`grade`, `curriculum: "kg-2024"`),
units and objectives. Then add topics as above. A `soon` subject shows as a
locked card and must have no units or topics yet. `inf` (informatics) is the
example.

**Add a property type** (for example `halfLife`). Add it to
`src/property-types/<subject>.json` with `valueKind`, `icon` and the default
`unit`. It becomes usable in props and comparison rows, and the build ships
it only in packages that use it.

**Add a glossary term.** Add `{ id, ky, ru, en, forbidden[], approvedBy }`
to `src/glossary/<subject>.json`. `forbidden` lists wrong variants that
translators must not use. Matching is on word boundaries, so never list a
correct inflected form, such as a genitive plural.

## 3D assets

Only clearly free sources: CC0, public domain / US government works, CC BY
(with attribution). The offline pipeline lives in `scripts/assets/` (its own
`package.json`; `npm install` there): `inspect.mjs` prints a GLB's node tree,
triangles and part centres; one script per topic (`human-heart.mjs`,
`earth-layers.mjs`) takes the downloaded source files as arguments, renames nodes to the concept
masks, simplifies, compresses with meshopt and writes WebP textures
(≤ 1024 px; KTX2 once `toktx` is in the pipeline). Budgets: ≤ 150k triangles
and ≤ 3 MB per GLB. Record every file in `assets/<key>/ASSET.json` and
`assets/CREDITS.md`, then rebuild. Done: `human-heart` (Human Reference Atlas,
CC BY 4.0), `earth-layers` (own geometry + NASA Blue Marble).

## Scale test (TZ §10)

`npx tsx scripts/seed-scale.mjs /tmp/bilig-scale` writes 20 subjects
(2 of them `soon`), 126 courses, 378 units, 2000 topics, 10 000 concepts and
5 languages (ky, ru, en, uz, tr). It validates every package and loads the
directory with `loadContentRepo`, printing sizes and timings. The data uses
the same layout as `content/`. It isn't wired to `npm run seed:scale`
because `package.json` is shared with parallel work. Add
`"seed:scale": "tsx scripts/seed-scale.mjs"` there when convenient.

Known limit: `LocalizedSchema` has exactly `ky`/`ru`/`en`. The extra
languages are accepted but stripped by Zod, so adding a real 4th or 5th UI
language needs a contract change (`LANGS`).
