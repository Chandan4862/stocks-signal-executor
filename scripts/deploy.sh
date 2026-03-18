#!/usr/bin/env bash
# Deploy latest changes on the server
# Run as: bash scripts/deploy.sh
#
# Can also be invoked remotely:
#   ssh your-server "cd ~/stocks-signal-executor && bash scripts/deploy.sh"

set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE_FILE="docker-compose.prod.yml"
BRANCH="${1:-main}"

echo "=== Pulling latest changes from '${BRANCH}' ==="
git pull origin "$BRANCH"

echo ""
echo "=== Rebuilding and restarting containers ==="
docker compose -f "$COMPOSE_FILE" up -d --build

echo ""
echo "=== Deployment complete ==="
echo ""
echo "Tailing app logs (Ctrl+C to exit)..."
docker compose -f "$COMPOSE_FILE" logs -f --tail=50 stock_app
