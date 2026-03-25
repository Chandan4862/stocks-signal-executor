#!/usr/bin/env bash
# Manually set up the daily backup cron job.
# Usage: sudo bash scripts/setup-cron.sh

set -u

USER_NAME="${SUDO_USER:-$USER}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_SCRIPT="${PROJECT_DIR}/scripts/backup.sh"

echo "=== Setting up daily backup cron ==="

if [ ! -f "$BACKUP_SCRIPT" ]; then
    echo "Error: ${BACKUP_SCRIPT} not found."
    exit 1
fi

chmod +x "$BACKUP_SCRIPT"

CRON_ENTRY="0 20 * * * ${BACKUP_SCRIPT} >> ${PROJECT_DIR}/backups/cron.log 2>&1"

# Add cron job (avoids duplicate entries)
(crontab -u "$USER_NAME" -l 2>/dev/null | grep -v "$BACKUP_SCRIPT"; echo "$CRON_ENTRY") \
    | crontab -u "$USER_NAME" -

echo "Backup cron installed for ${USER_NAME}: daily at 20:00 IST"
echo "Cron entry: ${CRON_ENTRY}"
echo ""
echo "Verify with: crontab -l"
