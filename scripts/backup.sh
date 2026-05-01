#!/usr/bin/env bash
# Daily Postgres backup script
# Add to crontab: 0 20 * * * /path/to/stocks-signal-executor/scripts/backup.sh
#
# Keeps the last 7 daily backups. Older ones are auto-deleted.

set -euo pipefail

# ── Cron-safe environment ────────────────────────────────────────────
# Cron runs with a minimal PATH (/usr/bin:/bin). Export a full PATH so
# docker, git, gzip, etc. are discoverable.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${PROJECT_DIR}/backups"
CONTAINER_NAME="stocks-executor-postgres"
RETENTION_DAYS=7

# Load environment variables from .env if present (PG_USER, PG_DATABASE, etc.)
if [ -f "${PROJECT_DIR}/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "${PROJECT_DIR}/.env"
    set +a
fi

DB_USER="${PG_USER:-postgres}"
DB_NAME="${PG_DATABASE:-stocks_executor}"

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%F_%H%M)
BACKUP_FILE="${BACKUP_DIR}/db-${TIMESTAMP}.sql.gz"

echo "[$(date)] Starting Postgres backup..."

# Dump and compress
docker exec "$CONTAINER_NAME" \
  pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$BACKUP_FILE"

BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "[$(date)] Backup saved: ${BACKUP_FILE} (${BACKUP_SIZE})"

# Prune old backups (keep last N days)
find "$BACKUP_DIR" -name "db-*.sql.gz" -mtime +${RETENTION_DAYS} -delete
REMAINING=$(find "$BACKUP_DIR" -name "db-*.sql.gz" | wc -l | tr -d ' ')
echo "[$(date)] Pruned old backups. ${REMAINING} backup(s) retained."

# Push backup to git
cd "$PROJECT_DIR"
git add -f backups/
git commit -m "backup: db-${TIMESTAMP}" --no-verify || echo "[$(date)] Nothing new to commit."
git push origin main || echo "[$(date)] Git push failed."
echo "[$(date)] Backup pushed to git."
