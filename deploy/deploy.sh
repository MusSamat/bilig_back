#!/usr/bin/env bash
# Build and (re)start Bilig on the server. Run from anywhere:
#   ~/bilig/bilig_back/deploy/deploy.sh
# Layout: <dir>/bilig_back and <dir>/bilig_ft side by side (push.sh uploads both).
# First run: creates deploy/production.env with fresh secrets and stops so you
# can set BILIG_URL (and the assistant key) — then run it again.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
back="$(dirname "$here")"
envf="$here/production.env"
compose=(docker compose -f "$here/docker-compose.yml" --env-file "$envf")

[ -d "$back/../bilig_ft" ] || { echo "bilig_ft not found next to bilig_back ($back/../bilig_ft)"; exit 1; }

if [ ! -f "$envf" ]; then
  umask 077
  sed -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" \
      -e "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" \
      -e "s/^PSEUDONYM_SECRET=.*/PSEUDONYM_SECRET=$(openssl rand -hex 32)/" \
      "$here/env.example" > "$envf"
  echo "Created $envf with new secrets."
  echo "Edit BILIG_URL (and TUTOR_PROVIDER / ANTHROPIC_API_KEY, the first admin), then run deploy.sh again."
  exit 0
fi

# Keep a database backup before every update (skipped on the very first start).
if "${compose[@]}" ps --status running postgres 2>/dev/null | grep -q postgres; then
  "$here/backup.sh" || echo "warning: backup failed, continuing"
fi

export GIT_COMMIT="$(cat "$back/.deploy-commit" 2>/dev/null || git -C "$back" rev-parse --short HEAD 2>/dev/null || echo unknown)"
"${compose[@]}" build --pull
"${compose[@]}" up -d --remove-orphans
echo "Waiting for the API to become healthy…"
for _ in $(seq 1 320); do  # up to ~16 min: an import after a content change runs before the API listens
  state="$("${compose[@]}" ps --format '{{.Service}} {{.Health}}' | awk '$1=="api"{print $2}')"
  [ "$state" = "healthy" ] && break
  sleep 3
done
"${compose[@]}" ps
port="$(grep -E '^BILIG_HTTP_PORT=' "$envf" | cut -d= -f2)"
curl -fsS "http://127.0.0.1:${port:-8081}/api/v1/health" && echo && echo "Bilig is up."
docker image prune -f >/dev/null
