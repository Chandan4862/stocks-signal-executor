#!/usr/bin/env bash
# One-time server setup script for Oracle Cloud ARM VM (Ubuntu 22.04/24.04)
# Run as: sudo bash scripts/setup.sh
#
# What this does:
#   1. Updates system packages
#   2. Installs Docker + Docker Compose plugin
#   3. Adds current user to docker group
#   4. Opens firewall for SSH only (Postgres stays internal)
#   5. Sets up daily backup cron job

set -euo pipefail

USER_NAME="${SUDO_USER:-$USER}"
PROJECT_DIR="/home/${USER_NAME}/stocks-signal-executor"

echo "=== [1/5] Updating system packages ==="
apt-get update -y && apt-get upgrade -y

echo "=== [2/5] Installing Docker ==="
if command -v docker &> /dev/null; then
    echo "Docker already installed: $(docker --version)"
else
    curl -fsSL https://get.docker.com | sh
    echo "Docker installed: $(docker --version)"
fi

echo "=== [3/5] Adding '${USER_NAME}' to docker group ==="
usermod -aG docker "$USER_NAME"

echo "=== [4/5] Configuring firewall (iptables) ==="
# Oracle Cloud uses iptables by default
# Allow SSH (22), deny everything else inbound
# Docker manages its own iptables rules for container networking
if command -v ufw &> /dev/null; then
    ufw allow 22/tcp
    ufw --force enable
    echo "UFW configured: SSH allowed"
else
    echo "UFW not found — using Oracle Cloud Security List (configure via console)"
fi

echo "=== [5/5] Setting up daily backup cron ==="
BACKUP_SCRIPT="${PROJECT_DIR}/scripts/backup.sh"
CRON_ENTRY="0 20 * * * ${BACKUP_SCRIPT} >> ${PROJECT_DIR}/backups/cron.log 2>&1"

if [ -f "$BACKUP_SCRIPT" ]; then
    chmod +x "$BACKUP_SCRIPT"
    # Add cron job for the non-root user (avoids duplicate entries)
    (crontab -u "$USER_NAME" -l 2>/dev/null | grep -v "$BACKUP_SCRIPT"; echo "$CRON_ENTRY") \
        | crontab -u "$USER_NAME" -
    echo "Backup cron installed for ${USER_NAME}: daily at 20:00"
else
    echo "Warning: ${BACKUP_SCRIPT} not found. Clone the repo first, then re-run."
fi

echo ""
echo "============================================"
echo " Setup complete!"
echo "============================================"
echo ""
echo " Next steps:"
echo "   1. Log out and back in (for docker group)"
echo "   2. cd ${PROJECT_DIR}"
echo "   3. cp .env.example .env && nano .env"
echo "   4. docker compose -f docker-compose.prod.yml up -d --build"
echo "   5. docker compose -f docker-compose.prod.yml logs -f stock_app"
echo ""
