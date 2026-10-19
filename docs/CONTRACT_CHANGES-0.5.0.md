# Contract 0.5.0: textbooks and the textbook menu

Contract `@bilig/content-model` and `@bilig/permissions` 0.4.0 → **0.5.0**.
Everything is additive. Older clients keep working.

A teacher opens the topic from **their own textbook**. A topic lives on its
own; a textbook only maps its chapters and lessons (with page ranges) onto
topic keys. One topic can appear in many textbooks.

The first textbook is «Табигый илимдер», 8 класс, часть 1
(`content/src/textbooks/tabigy-ilimder-8-1.json`): 8 chapters, 23 lessons,
one extra block (pollution and climate) and 8 chapter reviews. Its page
numbers are the numbers of the scanned files `p-NNN` (the printed numbering
of chapter 8 restarts at 1).

## 1. Schemas (`textbook.ts`)

```
Textbook { key, title, shortTitle?, grade 1–11, lang, part?, authors?, publisher?, year?, curriculum?, order,
           chapters: Chapter[] }
Chapter  { key, number, title, subjectKey, pages?: { from, to }, lessons: Lesson[] }
Lesson   { key, number, kind: lesson | review | extra, title, pages?, topicKeys: Key[] }
```

- Chapter and lesson keys are unique inside a textbook.
- A review lesson maps to every topic of its chapter.
- Helpers: `textbookSubjects`, `textbookTopicKeys`, `filterTextbookTopics`,
  `placesOfTopic` (where a topic appears: «§ 8.1, стр. 176–185»).
- `TextbookObjectSchema` is the plain object; `TextbookSchema` adds the
  duplicate-key check.

## 2. API

| Endpoint | Auth | Response |
|---|---|---|
| `GET /catalog` | `demo.view` | new optional `textbooks: Textbook[]` |
| `GET /textbooks?grade=&subjectKey=` | `demo.view` | `{ items: Textbook[] }` ordered by `order`, then grade |
| `GET /textbooks/:key` | `demo.view` | `{ textbook, topics: TopicSummary[] }` |
| `GET/POST /admin/textbooks`, `GET/PATCH/DELETE /admin/textbooks/:key` | read `content.draft.edit`, write `content.publish` | admin records |

Lessons in API responses list **published** topics only. A lesson whose
topics are not published yet keeps an empty `topicKeys` (the client shows it
as «скоро»). `subjectKey` filters by any chapter's subject.

## 2a. Sample scenes and tour steps

- `Sample.scene?: { params?, camera?, modes? }`: what the stage shows when the
  sample is selected. `params` are shallow-merged over `topic.scene.params`
  (same plugin), `camera` replaces the initial camera, `modes` sets scene
  modes. Helper: `sceneForSample(topic.scene, sample)`.
- `TourStep.sample?: Key`: the sample on the stage at that step (its scene
  applies). `validatePackage` errors on an unknown sample key.
- The build fills a sample's `scene` from its `content/src/thumbs.json` spec
  when the source does not set one, so the live stage and the thumbnail match.

## 3. Content build

`content/src/textbooks/<key>.json` = `{ "textbook": Textbook }`. The build
validates it and writes it into `catalog.json` (`textbooks`). Every topic key
must exist among the built topics (an error in a full build; skipped with
`--only` / `--partial`). The server stores textbooks as a content kind
(`Textbook` table) and seeds them from `catalog.json`.

## 4. New `sim` models (plugin-sim)

Procedural scenes for the lessons that need no model file. Each model names
its parts; concepts bind to them with `nodes` masks as usual. Params are
parsed leniently (bad values fall back to defaults). Units are SI unless noted.

### `kinematics` — 8.1 speed, 8.2 distance–time graphs
- params: `segments: { v: number /* m/s, ≥ 0 */, t: number /* s, > 0 */ }[]` (default `[{ v: 10, t: 10 }]`),
  `radar?: boolean`, `showGraph?: boolean` (default true), `markEvery?: number` (m between road markers, default 10).
- parts: `Car`, `Road`, `Marker_<n>`, `Radar`, `Stopwatch`, `Graph_Axes`, `Graph_Line`, `Graph_Point`.
- modes: `vectors` (velocity arrow `Arrow_Velocity`), `trace` (car positions each second), `graph` (default on).
- The car runs the segments in order; the graph draws s(t) as it goes (slope = speed; v = 0 is a flat line).

### `forces` — 8.3 forces
- params: `mass: kg` (default 1), `forces: { id: string, magnitude: N, angleDeg: number /* 0 = right, 90 = up */ }[]`,
  `gravity?: boolean` (default true: adds `Arrow_Gravity`, m·g down, and `Arrow_Normal` up while on the table),
  `friction?: number` (μ, default 0), `dynamometer?: boolean` (a spring scale pulling along the first force).
- parts: `Block`, `Table`, `Arrow_<id>`, `Arrow_Gravity`, `Arrow_Normal`, `Arrow_Friction`, `Arrow_Resultant`, `Dynamometer`, `Spring`.
- modes: `vectors` (default on), `resultant`, `labels` (magnitudes in N next to arrows).

### `lever` — 8.4 moment of a force (also 2.1 arm as a lever)
- params: `length: m` (default 2), `pivot: m from the left end` (default length/2),
  `loads: { id: string, position: m from the left end, mass: kg }[]`, `g?: number` (default 9.81).
- parts: `Beam`, `Pivot`, `Load_<id>`, `Arm_<id>` (distance from the pivot), `Arrow_<id>` (weight).
- modes: `vectors`, `arms` (default on), `balance` (beam tilts by the net moment Σ F·d; level when balanced).

### `particles` — 5.1 pure substances and mixtures, 5.3 solutions
- params: `species: { id: string, element?: string /* colour like in molecule */, hue?: number, count: number, radius?: number /* Å-like scale, default 1 */, place?: 'mixed' | 'top' | 'bottom' | 'clump' }[]`,
  `bonded?: { a: string, b: string }[]` (species ids drawn as joined pairs = compound),
  `temperature?: number` (°C, default 20: speed of motion), `dissolve?: number` (0–1: share of a solute already spread through the solvent).
- parts: `Container`, `Species_<id>` (one instanced group per species), `Solvent` (when a species has `place: 'mixed'` and the most particles).
- modes: `motion` (default on), `labels`, `zoom` (macro view: coloured liquid / layers instead of particles).

### `separation` — 5.2 separating mixtures
- params: `method: 'filtration' | 'evaporation' | 'distillation' | 'chromatography' | 'magnet' | 'decanting'`, `mixture?: string` (label only).
- parts by method — filtration: `Funnel`, `FilterPaper`, `Beaker`, `Residue`, `Filtrate`; evaporation: `Dish`, `Burner`, `Crystals`, `Vapour`;
  distillation: `Flask`, `Burner`, `Thermometer`, `Condenser`, `Distillate`, `Receiver`; chromatography: `Paper`, `Solvent`, `Spot_<n>`, `SolventFront`;
  magnet: `Magnet`, `IronFilings`, `Sand`; decanting: `Beaker`, `Sediment`, `Liquid`.
- modes: `run` (default on: animates the method), `labels`.

### `reaction-vessel` — 6.1–6.4 metals
- params: `metal: 'K'|'Na'|'Ca'|'Mg'|'Al'|'Zn'|'Fe'|'Cu'|'Ag'|'Au'`, `reagent: 'oxygen' | 'water' | 'steam' | 'acid'`,
  `compare?: string[]` (other metals shown side by side in the same reagent).
- The rate (bubbles, flame, colour change) follows the reactivity series:
  K > Na > Ca > Mg > Al > Zn > Fe > (H) > Cu > Ag > Au. With water only K, Na, Ca react visibly (Mg slowly; with steam Mg, Zn, Fe);
  with acid metals above H react; with oxygen Mg burns with a bright flame, Cu darkens, Au and Ag do not change.
- parts: `Vessel`, `Metal`, `Metal_<symbol>` (in compare mode), `Liquid`, `Bubbles` (H₂), `Flame`, `Product`, `Indicator`.
- modes: `run` (default on), `labels`, `indicator` (phenolphthalein turns pink where a base forms).

### `energy-profile` — 7.1 exothermic, 7.2 endothermic
- params: `kind: 'exo' | 'endo'`, `reactants: kJ` (default 100), `products: kJ` (default 40 for exo, 160 for endo),
  `activation: kJ` (peak above reactants, default 60), `startTemp: °C` (default 20), `deltaT: °C` (signed; default +25 exo / −10 endo),
  `compare?: boolean` (exo and endo diagrams side by side).
- parts: `Axis_Energy`, `Axis_Progress`, `Level_Reactants`, `Level_Products`, `Hump`, `Arrow_DeltaH`, `Arrow_Activation`, `Beaker`, `Thermometer`, `Graph_Temperature`.
- modes: `graph` (default on), `temperature` (thermometer + T(t) curve), `labels`.

### `food-web` — 3.1 ecosystems, 3.2 human impact, 3.x pollution
- params: `biome: 'lake' | 'steppe' | 'forest' | 'mountain'`, `organisms: { id: string, level: 'producer' | 'primary' | 'secondary' | 'tertiary' | 'decomposer', icon?: string, count?: number }[]`,
  `links: [eaten: string, eater: string][]`, `removed?: string[]` (organisms taken out: links fade, counts react),
  `pollutant?: { name?: string, start: number /* ppm in water/soil */, factor?: number /* × per level, default 10 */ }`.
- parts: `Sun`, `Organism_<id>`, `Link_<eaten>_<eater>`, `Level_<level>`, `Pollutant_<id>` (dots inside each organism).
- modes: `energy` (default on: arrows sized by the 10 % rule), `pollutant` (concentration grows up the chain), `labels`.

### `nutrition-plate` — 1.1 nutrients, 1.2 balanced diet, 1.3 habits
- params: `foods: { id: string, group: 'carbs' | 'proteins' | 'fats' | 'vitamins' | 'minerals' | 'water' | 'fibre', grams: number, kcal?: number }[]`,
  `target?: { kcal: number, carbs: %, proteins: %, fats: % }` (shows the balance against it), `test?: 'iodine' | 'biuret' | 'paper'` (virtual food test colour on the selected food).
- parts: `Plate`, `Food_<id>`, `Sector_<group>`, `Bar_<group>` (energy bars), `Scale` (kcal gauge).
- modes: `groups` (default on: plate sectors), `energy` (bars + gauge), `labels`.

## 5. Models from files (`gltf`)

New procedural GLBs from `scripts/assets` (same budget: ≤ 1.5 MB, ≤ 150k triangles, licence in `ASSET.json`):

- `skeleton-muscles/skeleton.glb` — nodes `Skel_Skull`, `Skel_Spine`, `Skel_Cervical`, `Skel_Clavicle_L/R`, `Skel_Scapula_L/R`, `Skel_Ribs`, `Skel_Sternum`, `Skel_Humerus_L/R`,
  `Skel_Radius_L/R`, `Skel_Ulna_L/R`, `Skel_Hand_L/R`, `Skel_Pelvis`, `Skel_Coccyx`, `Skel_Femur_L/R`, `Skel_Patella_L/R`, `Skel_Tibia_L/R`, `Skel_Fibula_L/R`, `Skel_Foot_L/R`,
  `Joint_Ball_Shoulder_L/R`, `Joint_Ball_Hip_L/R`, `Joint_Hinge_Elbow_L/R`, `Joint_Hinge_Knee_L/R`, `Muscle_Biceps_R`, `Muscle_Triceps_R`.
- `respiratory-system/respiratory.glb` — nodes `Nose`, `Larynx`, `Trachea`, `Bronchi_L/R`, `Bronchioles_L/R`, `Lung_L`, `Lung_R`, `Alveoli_1…n`, `Diaphragm`, `Ribs`.

## 6. КТП → lesson plans (`api/ktp.ts`)

A teacher uploads their календарно-тематический план (КТП, .docx). The
server parses and checks it, links each lesson to a Bilig topic, and builds
the official 45-minute lesson plan (сабак планы, .docx) for one lesson or a
range of up to 10 lessons, on click. Records are owner-only (another user's
plan is 404). New permission `lesson.plan`: teacher, school_admin, superadmin.

| Endpoint | Body / query | Response |
|---|---|---|
| `GET /ktp` | page query | `{ items: TeachingPlanSummary[], nextCursor }` |
| `POST /ktp` | `{ fileName, data: base64 .docx ≤ 4 MB, lang? }` | `TeachingPlan` |
| `GET /ktp/:id` | | `TeachingPlan` |
| `PATCH /ktp/:id` (If-Match) | `{ version, title?, subjectName?, subjectKey?, teacherName?, schoolName?, lang?, rows?: [{ index, title?, type?, hours?, homework?, dates?, topicKey? }] }` | `TeachingPlan` (issues recomputed) |
| `DELETE /ktp/:id` (If-Match) | | `{ ok }` |
| `GET /ktp/:id/lessons/:index/plan?class=8б&lang=` | | `.docx` |
| `GET /ktp/:id/plans?class=8б&from=1&to=5&lang=` | range ≤ 10 | one `.docx`, a plan per page |

- `KtpRow.index` is the position in the whole plan. КТП lesson numbers restart
  in every table; `number` keeps the printed one.
- Section headings («Сан (10 саат)») are split off the lesson title into `section`.
- Issues carry a `code`, a `severity` (`error` | `warning` | `info`), the
  lesson `row`, the `class` and `params`, so the client localizes them:
  `no_lessons`, `title_missing`, `date_missing`, `date_invalid`, `date_order`,
  `date_same_day` (info), `date_sunday`, `date_holiday` (fixed-date KG public
  holidays), `date_out_of_year`, `hours_mismatch`, `section_hours_mismatch`.
- Lesson type (`new` | `practice` | `test` | `analysis`) sets the stage
  timings; every plan totals 45 minutes.
- Content of a plan: from the linked topic package when `topicKey` is set
  (goal, objectives, tour, examples, quiz questions for the mini-test,
  textbook § and pages); otherwise a rule-based draft. Every plan carries
  the note that it is a draft the teacher checks; ПК codes stay for the
  teacher to choose.
