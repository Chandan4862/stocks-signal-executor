# Execution Flow — Trade Sync, Orders, and State

This document explains how the system consumes Active/Closed trade feeds, places BUY/SELL and Stop-Loss orders on Dhan, and records state in Redis and Postgres with strict idempotency.

## Overview

- Inputs: Normalized `ActiveTrade` and `ClosedTrade` objects from upstream APIs.
- Orchestration: `Scheduler` ticks → `TradeSyncService` reconciles → `DhanService` executes → `StateStore` persists → `TelegramService` alerts.
- Safety: Idempotency via correlation IDs + Redis keys; backoff on errors; market pause; per-trade serialization.

## High-Level Diagram

```
+----------------+        +------------------+        +----------------+
| Active/Closed  |  -->   | TradeSyncService |  -->   | Orchestrator   |
| Upstream APIs  |        | (normalize/cache)|        | (BUY/SL/SELL)  |
+----------------+        +------------------+        +----------------+
                                                        |     ^
                                                        v     |
                             +------------------+   +------------------+
                             | DhanService      |   | TelegramService  |
                             | (place/modify/   |   | (/token, alerts) |
                             |  cancel orders)  |   +------------------+
                             +---------+--------+
                                       |
                                +------+------+
                                |   Dhan API  |
                                +-------------+

      +---------------------+             +----------------------+
      | Redis (runtime)     |             | Postgres (persistent)|
      | - broker:token      |             | - trades             |
      | - idempotency:*     |             | - pnl_records        |
      | - trade:{id}        |             | - audit_logs         |
      | - tsl:{id}          |             | - token_store        |
      | - lock:trade:{id}   |             +----------------------+
      | - health:market     |
      +---------------------+

               ^                                        ^
               |                                        |
           +---+------------------------------+---------+---+
           |           Scheduler/Backoff/Health/Circuit     |
           +------------------------------------------------+
```

## Scheduler Tick

1. Ensure token: read `broker:token` (Redis). If absent/expired, fetch from Postgres `token_store` and cache. On 401/403, pause actions and ping Telegram to submit `/token <ACCESS_TOKEN> [YYYY-MM-DD]`.
2. Health checks: optionally verify `health:market`; pause on halt or stale CMP.
3. Fetch feeds: call upstream Active/Closed; normalize to `ActiveTrade`/`ClosedTrade`.
4. Reconcile per trade `id` with per-trade serialization using `lock:trade:{id}` (short TTL).

## Active → BUY + Initial SL-M

- Entry price resolution (priority): `active.meta.entry_price` → first executed fill in `active.history` → `active.cmp`.
- Quantity: choose `capital = active.meta.max_capital` (if present) else `MAX_TRADE_CAPITAL`; compute `qty = floor(capital / entry_price)`.
- BUY guard: skip if `idempotency:buy:{id}` exists; set `correlationId = buy:<id>`.
- BUY order (MARKET):
  - `placeOrder({ dhanClientId, correlationId, transactionType: BUY, exchangeSegment, productType, orderType: MARKET, validity: DAY, securityId: active.instrument.securityId, quantity: qty })`
  - On duplicate/409: reconcile via external lookup (correlation) and treat as success if present.
- Persist on success:
  - Redis: `idempotency:buy:{id}`, `trade:{id}` = { securityId, entry_price, qty, state: OPEN }.
  - DB: `trades` upsert (entry data, state OPEN); `audit_logs` (BUY request/response).
- Initial SL-M:
  - Compute trigger via `TSLService`: from `TSL_INITIAL_SL_PCT` or `active.meta.initial_sl_pct`.
  - Guard `idempotency:sl:{id}`; `correlationId = sl:<id>`.
  - `placeOrder({ orderType: STOP_LOSS_MARKET, transactionType: SELL, triggerPrice })` for full `qty`.
  - Redis: `tsl:{id}` = { slOrderId, triggerPrice, lastUpdatedAt }.
  - DB: `audit_logs` (SL placement). Telegram alert.

## TSL (Trailing Stop-Loss)

- Condition: when `active.cmp` rises by configured step (`TSL_STEP_RS` or percent) above last SL.
- Next trigger: `next = max(current_trigger, cmp - step)`, and never above `cmp`.
- Idempotency: guard `idempotency:tsl:{id}:{next}`.
- Modify preferred: `modifyOrder(slOrderId, { orderType: STOP_LOSS_MARKET, triggerPrice: next, validity: DAY })`.
- Fallback: `cancelOrder(slOrderId)` then re-`placeOrder` SL-M with `next` trigger.
- State & logs: update Redis `tsl:{id}`, add `audit_logs`, Telegram notify.

## Closed → Exit SELL + PnL

- Detection: `ClosedTrade` with same `id` (includes `exit_price`, `closed_on_dt`, `history`, `meta`).
- Guard: skip if `idempotency:sell:{id}` exists; set `correlationId = sell:<id>`.
- Cancel SL: if `tsl:{id}` present, `cancelOrder(slOrderId)` (best effort).
- SELL order (MARKET): `placeOrder({ transactionType: SELL, orderType: MARKET, quantity: qty, securityId, ... })`.
- Persist:
  - DB `trades`: set state CLOSED, `exit_price`, `exit_order_id`, `closed_on`.
  - DB `pnl_records`: insert realized PnL using entry and exit (from Closed or broker fills).
  - DB `audit_logs`: SELL request/response and finalization record.
  - Redis: `idempotency:sell:{id}`; clear `tsl:{id}`; update `trade:{id}` to CLOSED snapshot.
- Notify: Telegram exit summary with PnL.

## Redis Keys

- `broker:token`: Dhan access token, TTL until `token_store.expires_at`.
- `idempotency:buy:{id}`: prevents duplicate BUY.
- `idempotency:sl:{id}`: prevents duplicate initial SL-M.
- `idempotency:tsl:{id}:{trigger}`: prevents duplicate trailing updates.
- `idempotency:sell:{id}`: prevents duplicate SELL.
- `trade:{id}`: cached trade snapshot (securityId, qty, entry_price, state, sl info).
- `tsl:{id}`: { slOrderId, triggerPrice, lastUpdatedAt }.
- `lock:trade:{id}`: short-lived lock to serialize per-trade logic.
- `health:market`: optional market pause flag.

## Database Tables (touchpoints)

- `trades`:
  - On BUY: upsert with entry details, state OPEN.
  - On SELL: update with exit details, state CLOSED.
- `audit_logs`:
  - Each external call (BUY/SL/TSL/SELL) request/response, with `correlationId` and payloads.
- `pnl_records`:
  - On SELL finalization: insert realized PnL snapshot.
- `token_store`:
  - On `/token` via Telegram: upsert `{ token, source, expires_at }`.

## DhanService Contracts

- Auth header: `access-token: <token>`.
- Methods: `placeOrder`, `modifyOrder`, `cancelOrder`.
- Correlation ID: `buy:<id>`, `sl:<id>`, `tsl:<id>:<trigger>`, `sell:<id>` for broker-side de-dup.

## Error Handling & Safety

- Backoff: `utils/retry.ts` for transient errors (network/timeouts/429).
- Classification: broker validation vs transient; halt on repeated broker validation failures.
- Circuit breaker: optional counter to temporarily pause order placement on repeated failures.
- Market halt: pause actions when `health:market` indicates issues or CMP staleness detected.

## Token Lifecycle

- Source: env at boot, or Telegram `/token <ACCESS_TOKEN> [YYYY-MM-DD]`.
- Storage: Redis `broker:token` (TTL) + Postgres `token_store.expires_at`.
- Rotation: on 401/403, pause actions and prompt for new token; resume after validation/store.

## Telegram

- Commands: `/token`, `/positions`, `/pnl`, `/status`, `/logs`.
- Alerts: BUY placed, SL placed/updated, EXIT summary with PnL, and errors.
