# Docker — Run the Stocks Signal Executor

This guide sets up the app with Postgres and Redis via Docker Compose. It compiles TypeScript and runs the production build.

## Prerequisites

- Docker Desktop (macOS)
- A `.env.docker` file with your credentials (created below)

## Files Added

- `Dockerfile`: Multi-stage build (compile TS → run JS)
- `docker-compose.yml`: Services for `app`, `postgres`, `redis`
- `.env.docker`: Environment variables for the app in Docker
- `.dockerignore`: Keeps build context small

## Setup

1. Create `.env.docker` (already added):
   - Set `DHAN_CLIENT_ID`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
   - Optionally set `DHAN_ACCESS_TOKEN` or provide via Telegram `/token`.

2. Build and start:

```sh
# From project root
docker compose build
docker compose up -d
```

3. Check logs:

```sh
docker compose logs -f app
```

4. Stop services:

```sh
docker compose down
# To wipe data volumes as well:
docker compose down -v
```

## Services

- `app` (stocks-executor-app):
  - Builds with `Dockerfile`, runs `node dist/index.js`.
  - Reads env from `.env.docker`.
  - Depends on healthy `postgres` and `redis`.

- `postgres` (stocks-executor-postgres):
  - Image: `postgres:16-alpine`
  - Initializes schema from `db/schema.sql` via `/docker-entrypoint-initdb.d/01-schema.sql`.
  - Credentials sourced from `.env.docker` (`PG_*`).

- `redis` (stocks-executor-redis):
  - Image: `redis:7-alpine`
  - AOF enabled for persistence (`--appendonly yes`).

## Environment Variables

Key vars in `.env.docker`:

- Broker/Dhan: `DHAN_CLIENT_ID`, optional `DHAN_ACCESS_TOKEN`.
- Feeds: `ACTIVE_TRADES_URL`, `CLOSED_TRADES_URL`.
- Storage: `REDIS_URL` (defaults to `redis://redis:6379`), `PG_HOST=postgres`, `PG_PORT=5432`, `PG_DATABASE`, `PG_USER`, `PG_PASSWORD`.
- Telegram: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
- Bot config: `POLLING_INTERVAL_MS`, `MAX_TRADE_CAPITAL`, `TSL_*`.

## Health & Readiness

- Postgres: Healthchecked with `pg_isready` (depends_on condition).
- Redis: Healthchecked with `redis-cli ping`.
- App waits for healthy dependencies and then starts; internal services handle backoff and token checks.

## Useful Commands

```sh
# Connect to Postgres
docker exec -it stocks-executor-postgres psql -U postgres -d stocks_executor

# Inspect Redis keys
docker exec -it stocks-executor-redis redis-cli KEYS "*"

# Tail app logs
docker compose logs -f app

# Rebuild after code changes
docker compose build app && docker compose up -d app
```

## Notes

- The app authenticates the Dhan client via the `access-token: <token>` header; update token via Telegram `/token` when expired.
- Database is the system of record; Redis holds ephemeral runtime state and idempotency keys.
- For local testing, you can use mocked feed URLs and set `POLLING_INTERVAL_MS` higher to reduce noise.
