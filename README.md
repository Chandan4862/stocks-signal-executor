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

### Dhan Authentication

The bot authenticates with the Dhan API using an **access token** passed as the `access-token` HTTP header. Dhan access tokens are valid for **~24 hours**.

**Three ways to provide a token (in priority order):**

1. **TOTP auto-generation (recommended for automation)**
   - Set `DHAN_PIN` and `DHAN_TOTP_SECRET` in `.env`
   - Requires TOTP enabled on your Dhan account (Settings → DhanHQ Trading APIs → Setup TOTP)
   - The bot generates a fresh token automatically via `POST https://auth.dhan.co/app/generateAccessToken`

2. **Environment variable**
   - Set `DHAN_ACCESS_TOKEN` in `.env` with a token from [web.dhan.co](https://web.dhan.co)
   - Good for initial testing; token expires after ~24h

3. **Telegram `/token` command**
   - Send `/token YOUR_ACCESS_TOKEN [YYYY-MM-DD]` to the bot
   - The bot validates the token against Dhan's profile API before storing it

**Token lifecycle:**

- On each tick, the scheduler checks for a valid token (Redis → Postgres → env → TOTP generation)
- Active tokens can be renewed for another 24h via `/renew` Telegram command or the RenewToken API
- On HTTP 401/403, the DhanService automatically invalidates the cached token, obtains a fresh one, and retries the request
- If no valid token is available, trading is paused and a Telegram alert is sent

**Token storage:**

- Fast path: Redis key `broker:token` with TTL
- Durable: Postgres `token_store` table with `expires_at` for audit and recovery

### Risk & Caps

- `MAX_TRADE_CAPITAL`: per-trade capital cap (default Rs.10000). Quantity = `floor(capital / entry_price)`.
- `MAX_ACTIVE_TRADES`: portfolio cap for concurrent OPEN trades (default 10). New BUYs are skipped when this limit is reached.

## Business Logic/Flowchart
