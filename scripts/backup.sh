#!/bin/sh
# Daily Postgres backup, keeping the last 14. Run from the project folder on the VPS, e.g. with cron:
#   0 3 * * * cd /opt/gi-tracker && ./scripts/backup.sh >> backups/backup.log 2>&1
set -eu
mkdir -p backups
file="backups/gitracker-$(date +%Y-%m-%d-%H%M).sql.gz"
docker compose exec -T postgres pg_dump -U gitracker -d gitracker | gzip > "$file"
echo "$(date) wrote $file ($(du -h "$file" | cut -f1))"
ls -1t backups/gitracker-*.sql.gz | tail -n +15 | xargs -r rm --
