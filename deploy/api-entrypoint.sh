#!/bin/sh
# Start-up of the API container: apply migrations, import the content shipped
# in the image (idempotent: only changed topics get a new version), then serve.
set -eu
cd /app
echo "[bilig] prisma migrate deploy"
npx --no-install prisma migrate deploy
echo "[bilig] importing content"
npx --no-install tsx scripts/db-seed.ts
echo "[bilig] starting API (commit ${GIT_COMMIT:-unknown})"
exec npx --no-install tsx src/main.ts
