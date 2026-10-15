# bilig_back

API for **Bilig**, a data-driven 3D STEM learning platform for schools of
Kyrgyzstan (ky / ru / en, offline-first). The client is the separate repo
[`bilig_ft`](../bilig_ft).

## Layout

```
src/                 Fastify API: catalog, content packages, /api/tutor, RBAC
packages/
  permissions/       RBAC matrix with scope            — @bilig/permissions
  content-model/     content schema + zod validators   — @bilig/content-model
docs/TZ.md           technical specification
```

`packages/*` is the **shared contract**, and `bilig_ft` holds a copy of it.
Make every change to `packages/permissions` or `packages/content-model` in
both repos, in the same version (see TZ §7).

## Run / test

```bash
npm install
cp .env.example .env      # ANTHROPIC_API_KEY — without it /api/tutor returns 503
npm run start:dev         # http://localhost:3000
npm test
npm run typecheck
```
