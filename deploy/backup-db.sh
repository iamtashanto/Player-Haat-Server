#!/usr/bin/env bash
# Nightly PostgreSQL backup with retention. Cron example (as the postgres/playerhaat user):
#   15 2 * * *  /srv/playerhaat/server/deploy/backup-db.sh >> /var/log/playerhaat-backup.log 2>&1
#
#   DATABASE_URL=postgresql://user:pass@localhost:5432/playerhaat BACKUP_DIR=/var/backups/playerhaat KEEP_DAYS=14 ./backup-db.sh
# Restore:  pg_restore --clean --if-exists --no-owner -d playerhaat /var/backups/playerhaat/playerhaat-YYYY-MM-DD_HHMM.dump
# Copy the dumps OFF the server too (rclone/rsync to another provider) — a backup on the same disk isn't one.
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/playerhaat}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y-%m-%d_%H%M)"
OUT="$BACKUP_DIR/playerhaat-$STAMP.dump"

mkdir -p "$BACKUP_DIR"
umask 077
# libpq doesn't understand Prisma's "?schema=public" suffix
pg_dump --format=custom --no-owner --dbname="${DATABASE_URL%%\?*}" --file="$OUT.partial"
mv "$OUT.partial" "$OUT"
pg_restore --list "$OUT" > /dev/null   # fail loudly if the dump is unreadable
find "$BACKUP_DIR" -name 'playerhaat-*.dump' -mtime +"$KEEP_DAYS" -delete
echo "$(date +%Y-%m-%dT%H:%M:%S%z) backup ok: $OUT ($(du -h "$OUT" | cut -f1))"
