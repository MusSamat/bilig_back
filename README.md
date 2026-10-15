# Bilig

Data-driven, plugin-based **3D STEM learning platform** for schools of Kyrgyzstan.
Trilingual (**ky / ru / en**), **offline-first**, teacher-first. Students and
teachers explore real 3D topics (cells, molecules, …) instead of flat textbook
images, with an AI tutor that answers in the language of the question.

> Core principle (from the TZ): **no screen hard-codes a subject or topic name.**
> Subjects, topics, scenes, the viewer's modes — all built from data + plugins.
> The engine stays stable from 1 to 2000+ topics.

## Monorepo layout

```
packages/
  permissions/      RBAC matrix with scope (backend-authoritative)   — @bilig/permissions
  content-model/    data-driven content schema + zod validators      — @bilig/content-model
  scene-core/       viewer plugin contract + pure logic              — @bilig/scene-core
                    (tokens W-03, selection W-21, navigation W-04,
                     url-state W-05, progress W-11, registry)
apps/
  bilig_ft/         client (Vite + React + react-three-fiber + i18next + PWA)
  bilig_back/       API (Fastify + TS): catalog, packages, /api/tutor, RBAC
  bilig_admin/      content/GLB/publish admin           (planned — TZ §apps/admin)
  bilig_edge/       offline school mirror               (planned — TZ phase 3)
  bilig_worker/     3D processing + package building     (planned)
docs/TZ.pdf         the technical specification
```

## Requirements

- Node ≥ 20 (the repo targets 20; some deps prefer 22 — warnings only)
- npm (workspaces)

## Run

```bash
npm install

# backend on :3000  (AI tutor returns 503 without ANTHROPIC_API_KEY — client
# then uses its offline search; copy apps/bilig_back/.env.example to .env)
npm run dev:back

# client on :5173 (proxies /api -> :3000)
npm run dev:ft
```

Open http://localhost:5173 → pick **Biology** → the **Animal cell** topic:
rotate the model, click organelles (the membrane shell never steals a click from
an inner structure — W-21), toggle **Labels / Section**, switch **RU/KY/EN** live,
and watch the URL round-trip the selection (`?focus=bio.nucleus` — W-05).

## Test / build

```bash
npm test                              # vitest — 73 tests across packages + api
npm run build:ft                      # production client bundle + PWA service worker
npm run typecheck --workspaces --if-present
```

## Architecture notes

- **Permissions** are checked **only on the backend** against `@bilig/permissions`;
  the client consumes the same list and merely hides buttons it can't use (TZ §2).
- **Content** is a package (`ContentPackage`) — the offline unit the PWA caches.
  Adding a subject/topic is a data change, not a code change.
- **Scene plugins** implement one contract (`ScenePlugin`): `modesFor()`,
  a React/r3f `Component`, optional `readouts()`. The viewer (`bilig_ft`) is
  identical for every subject; `glb`/`molecule`/`crystal`/`geometry`/`sim` differ
  only in their plugin.
- **AI tutor**: `POST /api/tutor` → Claude (`claude-opus-4-8`), answers in the
  question's language, 9s timeout; **503 ⇒ client offline fallback** (TZ W-32).

## Status

| Area | State |
|------|-------|
| Shared core (permissions, content-model, scene-core) + tests | ✅ |
| `bilig_back` (catalog, packages, tutor, RBAC) | ✅ |
| `bilig_ft` (shell, catalog, 3D viewer, concept card, i18n, PWA) | ✅ |
| Processes/quiz/comparison UI, assistant panel, presentation export | ⬜ next |
| `bilig_admin`, `bilig_worker`, `bilig_edge` | ⬜ planned |

See `docs/TZ.pdf` for the full specification.
