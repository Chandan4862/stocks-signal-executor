# Project Phases — Plan & Roadmap

This single document captures all phases: current foundation, near-term implementation, and future enhancements.

## Phase 1 — Foundation (Done)

- TypeScript Node scaffolding (`package.json`, `tsconfig.json`, scripts).
- Environment config with `dotenv` + `zod` (`src/config`).
- Models & enums: Active/Closed trades, ExecutedTrade, Order, PnL; `TradeState`, `OrderState`, `LifecycleEvents`.
- Service skeletons: Auth, Dhan, Trade Sync, Symbol/Quantity Resolver, TSL, PnL, Audit Log, Telegram, Scheduler, StateStore.
- Redis key strategy: tokens, idempotency, trade cache, TSL state, market health.
- DB schema draft in `db/schema.sql`.
- Scheduler skeleton with retry/backoff.

## Phase 2 — Implementation (In Progress)

- Auth & Tokens (Dhan)
  - Use Dhan access token (~30 days). Primary source: env/secrets; fallback/update via Telegram.
  - Token Lifecycle:
    - On startup, read token from Redis (TTL) or Postgres (`token_store` with `expires_at`).
    - If expired/invalid (401/403), prompt via Telegram to submit a new token using `/token <ACCESS_TOKEN> [YYYY-MM-DD]`.
    - On receiving `/token`, validate with a lightweight Dhan ping, then store:
      - Redis key `broker:token` with TTL until `expires_at`.
      - Postgres `token_store` row with `expires_at` for audit and recovery.
  - Shared HTTP client adds `access-token: <token>`; auto-retries after token refresh.
- Trade Sync & Idempotency (aligned to `ActiveTrade`/`ClosedTrade`)
  - Inputs: normalized `ActiveTrade` (e.g., `id`, `sc_id`, `instrument.securityId`, `cmp`, `meta`, epochs) and `ClosedTrade` (e.g., `id`, `exit_price`, `history`, `meta`, `closed_on_dt`).
  - Discovery & Cache: Poll upstream Active/Closed; normalize; cache `trade:{id}` in Redis with `securityId`, `entry_price`, `quantity`, and current state for quick reconciliation.
  - New Active:
    - Entry Price: prefer `meta.entry_price`; else use first executed fill from `history` if present; fallback to `cmp`.
    - Quantity: prefer `meta.max_capital`; else config `MAX_TRADE_CAPITAL`; compute `qty = floor(capital / entry_price)`.
    - BUY Placement: guard `idempotency:buy:{id}`; set `correlationId = buy:<id>`; place BUY MARKET with `securityId`, `qty`, configured `productType`; persist order and set guard key.
    - Initial SL-M: compute trigger via `TSLService` using `entry_price` and `TSL_INITIAL_SL_PCT` (or `meta.initial_sl_pct` if provided); guard `idempotency:sl:{id}`; set `correlationId = sl:<id>`; place SL-M SELL for `qty`; store `slOrderId` and current `triggerPrice` in Redis `tsl:{id}`.
  - TSL Adjustments:
    - When `cmp` advances past configured steps (`TSL_STEP_RS` or `%`), recompute `nextStopLoss` below `cmp`; modify existing SL via `slOrderId` (or cancel + re-place if modify fails).
    - Guard each upgrade with `idempotency:tsl:{id}:{trigger}`; update `tsl:{id}` snapshot.
  - Closed Transition:
    - On `ClosedTrade` detection for `id` (or Active → Closed), cancel SL if present; guard `idempotency:sell:{id}`; set `correlationId = sell:<id>`; place SELL MARKET.
    - PnL: compute from `entry_price` (Active/Closed `meta`) and `exit_price` (Closed or broker fills); persist to `pnl_records`; audit + Telegram notify.
  - Safety & Control:
    - Use exponential backoff for transient failures; classify errors; serialize per `id` to avoid races; pause trading on CMP staleness/market halt and resume when healthy.
- Order Execution via `DhanService`
  - `placeOrder`: single method for BUY/SELL/SL-M. Payload includes `dhanClientId`, `correlationId`, `transactionType`, `exchangeSegment`, `productType`, `orderType` (`MARKET`/`LIMIT`/`STOP_LOSS_MARKET`), `validity`, `securityId`, `quantity`, and optional `price`/`triggerPrice`. Use `correlationId` for idempotency.
  - Stop-Loss placement: use `placeOrder` with `orderType: STOP_LOSS_MARKET` and `triggerPrice` computed by `TSLService`.
  - SL modify: use `modifyOrder(orderId, { orderType: STOP_LOSS_MARKET, triggerPrice, validity })` for up-only adjustments; fallback to `cancelOrder(orderId)` then re-place via `placeOrder` if modify fails.
  - Cancel: use `cancelOrder(orderId)` for pending SL or other orders when required.
- TSL Logic
  - Initial SL from `TSL_INITIAL_SL_PCT` below entry.
  - Trailing with configurable absolute Rs or % step; never set SL above CMP.
  - Persist current SL in Redis `tsl:{id}`.
- Persistence & State
  - Postgres tables: `trades`, `audit_logs`, `pnl_records`; indexes for reporting.
  - Redis keys for tokens, idempotency, trade cache, tsl state, market health.
- Reliability & Safety
  - Exponential backoff (`utils/retry.ts`), capped retries.
  - Failure categorization (network, rate-limit, broker validation, transient).
  - Circuit breakers to suspend order placement after repeated failures.
  - Market halt detection → pause.
- Telegram
  - Commands: `/positions`, `/pnl`, `/status`, `/logs`.
  - Alerts: BUY, SL placed/updated, EXIT, PnL, errors.
- Scheduler Orchestration
  - Tick: ensure valid token (Redis/DB) → fetch Active/Closed → reconcile → execute → persist → notify.
  - If token invalid/expired, pause trading actions and send Telegram prompt to update token.
  - Respect market windows; serialize per-trade to avoid race conditions.
- Observability
  - Structured logs with correlation IDs; metrics on latencies and failures.
  - Health heartbeat logs or endpoint.
- Testing & Dry-Run
  - Mocks for Dhan endpoints; dry-run mode (no real orders).
  - E2E in sandbox/min-qty.
- Deployment
  - PM2/Docker; secrets via env/manager; single-instance scheduling.
- Milestones
  1. TradeSync fetch/normalize + idempotency keys
  2. BUY + initial SL placement
  3. Token management + HTTP client
  4. Closed transition: SELL + PnL
  5. TSL adjustments
  6. Persistence + Audit
  7. Telegram commands + notifications
  8. Observability + health checks

### Detailed Trade Flow (Dhan)

- Order Types & Product
  - Use `MARKET` for BUY/SELL to prioritize execution; use `STOP_LOSS_MARKET` (SL-M) for protective stops.
  - `productType`: `CNC` (delivery) or `INTRADAY` via config.
  - Idempotency: set `correlationId` per action and guard with Redis keys (`idempotency:{buy|sl|sell}:{id}`).

- Instrument ID
  - Assume upstream APIs provide Dhan `securityId` directly (preferred). If not, mapping can be handled externally; the bot does not manage instrument resolution.

- BUY (POST `/v2/orders`)
  - Preflight: token valid (Redis/DB), market healthy, `idempotency:buy:{id}` not set.
  - Quantity: `floor(maxTradeCapital / entry_price)` (config).
  - Payload:
    ```json
    {
      "dhanClientId": "<CLIENT_ID>",
      "correlationId": "buy:<ID>",
      "transactionType": "BUY",
      "exchangeSegment": "NSE_EQ",
      "productType": "CNC",
      "orderType": "MARKET",
      "validity": "DAY",
      "securityId": "<SECURITY_ID>",
      "quantity": <QTY>
    }
    ```
  - Persist trade entry, audit, Telegram notify.

- Initial SL (SL-M) (POST `/v2/orders`)
  - SL trigger: `TSL_INITIAL_SL_PCT` below entry via `TSLService`.
  - Payload:
    ```json
    {
      "dhanClientId": "<CLIENT_ID>",
      "correlationId": "sl:<ID>",
      "transactionType": "SELL",
      "exchangeSegment": "NSE_EQ",
      "productType": "CNC",
      "orderType": "STOP_LOSS_MARKET",
      "validity": "DAY",
      "securityId": "<SECURITY_ID>",
      "quantity": <QTY>,
      "triggerPrice": <SL_TRIGGER>
    }
    ```
  - Store `slOrderId` in state (Redis `tsl:{id}`), audit, notify.

- TSL Upgrades
  - On CMP rising past configured steps (Rs or %), compute `nextStopLoss` (never above CMP).
  - Modify (PUT `/v2/orders/{slOrderId}`):
    ```json
    {
      "dhanClientId": "<CLIENT_ID>",
      "orderId": "<SL_ORDER_ID>",
      "orderType": "STOP_LOSS_MARKET",
      "triggerPrice": <NEW_SL_TRIGGER>,
      "validity": "DAY"
    }
    ```
  - Fallback: cancel old SL and re-place new SL-M if modify fails.
  - Audit each SL change; persist current SL in Redis `tsl:{id}`.

- EXIT (SELL Market)
  - Trigger: Closed trade detected for `id`.
  - Cancel SL (DELETE `/v2/orders/{slOrderId}`), then place SELL MARKET:
    ```json
    {
      "dhanClientId": "<CLIENT_ID>",
      "correlationId": "sell:<ID>",
      "transactionType": "SELL",
      "exchangeSegment": "NSE_EQ",
      "productType": "CNC",
      "orderType": "MARKET",
      "validity": "DAY",
      "securityId": "<SECURITY_ID>",
      "quantity": <QTY>
    }
    ```
  - Compute PnL from executed price(s) (`averageTradedPrice` or trades API), persist in `pnl_records`, audit, Telegram notify.

- Safety & Retries
  - Use exponential backoff for transient errors; classify broker/validation vs network.
  - Pause actions on market halt/no-tick; resume when healthy.
  - Leverage `correlationId` for de-duplication and lookup via `/orders/external/{correlationId}`.

## Phase 3 — Enhancements (Planned)

- Options/F&O support: Symbol resolver extensions, lot sizing, additional order types.
- Advanced TSL strategies: volatility-adaptive trailing, ATR-based SL.
- Risk management: portfolio exposure caps, per-symbol throttles, margin checks.
- Multi-broker abstraction: unify service interface to swap providers.
- Analytics & dashboards: PnL breakdowns, performance reports, alerting.
- High-availability: leader election for scheduler, failover.

## References

- Architecture overview: `ARCHITECTURE.md`.
- Environment setup & quick start: `README.md`.
