# Stocks Signal Executor — Architecture Overview

This document explains the overall flow of the implementation and what each file is used for. Phase 1 focuses on foundation setup (TypeScript, config, models, enums, service skeletons, scheduler).

## Flow Overview

- Boot: `src/index.ts` loads config and starts the `Scheduler`.
- Scheduler: ticks on a configured interval and (in Phase 2) orchestrates authentication, active/closed trade sync, idempotent order execution, and notifications.
- Services: loosely-coupled modules encapsulate responsibilities: authentication, Dhan API operations, trade reconciliation, symbol/quantity resolution, TSL adjustments, PnL computation, audit logging, Telegram commands, and state storage.
- State: Redis caches broker access token and idempotency keys; Postgres persists trades, audit logs, and PnL records.

## Runtime Sequence (Phase 1 → Phase 2)

1. Config is validated via `dotenv` + `zod`.
2. `Scheduler` wakes up per `pollingIntervalMs`.
3. (Phase 2) `AuthService` ensures a valid enctoken, refreshing pre-market.
4. (Phase 2) `TradeSyncService` polls Active/Closed APIs and reconciles state:
   - New active trade → compute `tradingsymbol` + `qty`, place BUY, place GTT SL, persist and notify.
   - Active → Closed transition → cancel GTT, place SELL, compute PnL, persist and notify.
5. (Phase 2) `TSLService` adjusts SL upward when CMP rises (idempotent).
6. `AuditLogService` records immutable events, `TelegramService` notifies/serves commands.

## Services

- `src/services/authService.ts`: TOTP-based enctoken login (no Puppeteer). Caches token per trading day in Redis; checks pre-market refresh window.
- `src/services/dhanService.ts`: Wraps Dhan API endpoints for market orders and stop-loss operations; uses `access-token: <token>` header and enforces idempotency via correlation IDs/Redis (access token ~30 days).
- `src/services/tradeSyncService.ts`: Reconciles Active vs Closed trades, drives BUY/SELL/GTT flows, detects transitions, pauses on market halts.
- `src/services/symbolResolverService.ts`: Maps `sc_symbol` to NSE `tradingsymbol` (Phase 1 trivial mapping; extensible for F&O).
- `src/services/quantityResolverService.ts`: Derives quantity from entry price vs `MAX_TRADE_CAPITAL`.
- `src/services/tslService.ts`: Trailing stop logic; initial SL and upward-only adjustments.
- `src/services/pnlService.ts`: Computes realized PnL = (exit − entry) × qty.
- `src/services/auditLogService.ts`: Immutable event journal; persists lifecycle events to Postgres.
- `src/services/telegramService.ts`: Notifications and basic commands `/positions`, `/pnl`, `/status`, `/logs`.
- `src/services/stateStore.ts`: Initializes Redis and Postgres connections; abstraction for persistence and caching.
- `src/services/scheduler.ts`: Interval orchestration with retry/backoff; will call other services in Phase 2.

## Models & Enums

- `src/models/activeTrade.ts`: Input schema from ActiveTrades API (equity, cash, recommended buy details).
- `src/models/closedTrade.ts`: Input schema from ClosedTrades API (exit info and closing timestamp).
- `src/models/executedTrade.ts`: Persisted trade snapshot (entry/exit, qty, state) for our system.
- `src/models/kiteOrder.ts`: Standardized order representation (transaction type, order type, status).
- `src/models/pnlRecord.ts`: Realized PnL record shape for storage/reporting.
- `src/enums/trade.ts`: `TradeState`, `OrderState`, `LifecycleEvents` used across services and persistence.

## Config

- `src/config/schema.ts`: Zod schemas for app config, including `tsl` parameters; strongly typed `AppConfig` export.
- `src/config/index.ts`: Loads `.env` via `dotenv`, validates against schema, returns typed `AppConfig`.
- `.env.example`: Credential and parameter placeholders (trading API credentials, APIs, Redis, Postgres, Telegram, polling, capital, TSL, pre-market refresh window).

## State & Persistence

- `src/state/redisKeys.ts`: Namespaced Redis keys:
  - `broker:token`: Dhan access token (TTL aligned to `expires_at`).
  - `idempotency:{action}:{id}`: BUY/SELL/GTT action deduplication.
  - `trade:{id}`: active trade cache.
  - `tsl:{id}`: TSL intermediate state.
  - `health:market`: market halt/resume flag.
- `db/schema.sql`: Postgres tables:
  - `trades`: entered/exited trades with quantities and prices.
  - `audit_logs`: immutable event journal with JSON payload.
  - `pnl_records`: realized PnL snapshots.
  - `token_store`: persisted broker access tokens with `expires_at` (redundancy and recovery beyond Redis).

## Reliability & Safety

- `src/utils/retry.ts`: Exponential backoff utility used by scheduler and external calls.
- Idempotency: Redis keys prevent duplicate BUY/SELL/GTT across cycles/restarts.
- Market health: ability to pause trading during exchange downtime.
- Session maintenance: pre-market refresh ensures a valid Kite session before trading.

## File Index (Purpose)

- `src/index.ts`: Entry point; loads config and starts scheduler.
- `src/config/schema.ts`: Config types and validation rules.
- `src/config/index.ts`: Runtime config loader.
- `src/enums/trade.ts`: Shared enums for trade/order lifecycle.
- `src/models/*.ts`: TypeScript interfaces describing payloads and records.
- `src/services/authService.ts`: Enctoken login and refresh window checks.
- `src/services/dhanService.ts`: Order and stop-loss operations (stubs in Phase 1).
- `src/services/tradeSyncService.ts`: Active/Closed reconciliation engine (to be implemented in Phase 2).
- `src/services/symbolResolverService.ts`: `sc_symbol` → `tradingsymbol` mapping.
- `src/services/quantityResolverService.ts`: Quantity derivation logic.
- `src/services/tslService.ts`: Trailing stop logic, initial SL.
- `src/services/pnlService.ts`: Realized PnL computation.
- `src/services/auditLogService.ts`: Event logging (console in Phase 1, DB in Phase 2).
- `src/services/telegramService.ts`: Notifications and command handling (stubs in Phase 1).
- `src/services/stateStore.ts`: Redis and Postgres setup.
- `src/services/scheduler.ts`: Interval runner with backoff.
- `src/state/redisKeys.ts`: Redis key namespaces.
- `src/utils/retry.ts`: Backoff utility.
- `db/schema.sql`: Database schema draft.
- `package.json`, `tsconfig.json`, `.gitignore`, `README.md`, `.env.example`: Project configuration, scripts, and documentation.

## Notes

- Phase 1 deliberately stubs external integrations to focus on architecture and typing; Phase 2 will implement real HTTP calls, command handlers, and persistence ops.
- The codebase is designed for equity first, with clear extension points for options (e.g., `SymbolResolverService`).
- For the consolidated plan across all phases, see `PHASES.md`.
