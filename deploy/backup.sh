#!/usr/bin/env bash
# Daily-safe PostgreSQL dump of the Bilig database, kept for 14 days.
#   deploy/backup.sh                  # one dump now
#   crontab: 30 3 * * * /home/<user>/bilig/bilig_back/deploy/backup.sh >/dev/null 2>&1
# Restore: gunzip -c deploy/backups/<file>.sql.gz | docker compose -f deploy/docker-compose.yml \
#            --env-file deploy/production.env exec -T postgres psql -U bilig -d bilig
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/backups"
mkdir -p "$out"
file="$out/bilig-$(date +%Y%m%d-%H%M%S).sql.gz"
docker compose -f "$here/docker-compose.yml" --env-file "$here/production.env" exec -T postgres \
  pg_dump -U bilig -d bilig --no-owner --clean --if-exists | gzip -9 > "$file"
find "$out" -name 'bilig-*.sql.gz' -mtime +14 -delete
echo "backup: $file ($(du -h "$file" | cut -f1))"
