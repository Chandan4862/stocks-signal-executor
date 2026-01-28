# Stocks Signal Executor (Phase 1)

Node.js (TypeScript) bot to execute trades via Dhan API, syncing Active/Closed trades APIs and notifying via Telegram. Phase 1 sets the foundation: project setup, config schema, models, enums, and service skeletons.

## Quick Start

```sh
# macOS zsh
cd stocks-signal-executor
cp .env.example .env
npm install
npm run dev
```

## Environment

See `.env.example`. In production, store secrets in a secrets manager (e.g., AWS Secrets Manager).

### Dhan Auth

- The HTTP client authenticates with the header `access-token: <token>`.
- Tokens last ~30 days; the bot stores the token in Redis (`broker:token`) with TTL and persists a copy in Postgres (`token_store.expires_at`).

## Business Logic/Flowchart
