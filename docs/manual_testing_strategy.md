# Manual Testing Strategy

## The Problem

The scheduler fires at fixed IST times (09:20, 10:00, 14:30, etc.), making it impossible to test during development. The solution: **use existing Telegram commands to trigger each phase on-demand**, combined with the **mock server admin API** to control the simulated environment.

## Prerequisites

```bash
# 1. Start everything with mock server
docker compose up --build

# 2. Verify services are running
docker compose ps
# Expected: stock_app, stock_worker, stock_mock, postgres, redis — all running

# 3. Verify mock server is responding
curl http://localhost:4000/admin/state | jq .
```

> **IMPORTANT:** Make sure `.env` or `docker-compose.yml` overrides point to the mock server:
>
> - `DHAN_API_BASE_URL=http://stock_mock:4000`
> - `ACTIVE_TRADES_URL=http://stock_mock:4000/api/active-trades`
> - `CLOSED_TRADES_URL=http://stock_mock:4000/api/closed-trades`

---

## Test Triggers (Bypassing Scheduler)

You already have these Telegram commands that call scheduler methods directly:

| Command      | What it does                                 | Scheduler method      |
| :----------- | :------------------------------------------- | :-------------------- |
| `/trade`     | Fetch signals → enqueue trade execution jobs | `runTradeScan()`      |
| `/monitor`   | Check pending fills + entered trades         | `runMonitor()`        |
| `/reconcile` | Cross-check Dhan holdings vs DB              | `runReconciliation()` |

These work at **any time** — they bypass the IST-based timers entirely.

---

## Test Scenario 1: Full Trade Entry Lifecycle

### Step 1 — Seed mock signals

```bash
curl -X POST http://localhost:4000/admin/signals/add-active \
  -H "Content-Type: application/json" \
  -d '{
    "id": 1001,
    "sc_symbol": "RELIANCE",
    "entry_price": 2800,
    "stoploss_price": 2750,
    "target_price_1": 2900,
    "segment": "Cash",
    "meta_data": "{\"qty_per_trade\": 10}"
  }'
```

### Step 2 — Set a fake token in Redis

```bash
docker exec stock_redis redis-cli SET "token:1" "mock-token-12345"
docker exec stock_redis redis-cli EXPIRE "token:1" 86400
```

### Step 3 — Trigger trade scan via Telegram

Send `/trade` in the Telegram bot chat.

### Step 4 — Verify

```bash
# Check mock server state — should have orders
curl http://localhost:4000/admin/state | jq '.orders'

# Check database
docker exec stock_postgres psql -U postgres -d stocks_executor_dev \
  -c "SELECT id, symbol, state, buy_order_id, sl_order_id FROM trades WHERE user_id = 1"

# Check notification queue
docker exec stock_redis redis-cli LLEN "bull:notification:waiting"
```

### Expected Result

- BUY order placed on mock Dhan
- SL (forever) order placed on mock Dhan
- Trade record in DB with state `AWAITING_ENTRY` or `ENTERED`
- Notification job enqueued → Telegram message received

---

## Test Scenario 2: Trade Monitoring

After the trade from Scenario 1 exists, send `/monitor` in Telegram.

```bash
docker exec stock_postgres psql -U postgres -d stocks_executor_dev \
  -c "SELECT id, symbol, state, entry_price FROM trades WHERE user_id = 1"
```

- PENDING_ENTRY trades → checked against mock Dhan order status → updated to ENTERED
- ENTERED trades → checked for SL trigger / target hit

---

## Test Scenario 3: Closed Trades Reconciliation

### Step 1 — Close a signal via mock admin API

```bash
curl -X POST http://localhost:4000/admin/signals/close/1001 \
  -H "Content-Type: application/json" \
  -d '{"exit_price": 2850}'
```

### Step 2 — Trigger closed trades scan

> **NOTE:** There's no `/closedtrades` command yet. See the "Missing Command" section below for how to add one.

### Step 3 — Verify

```bash
docker exec stock_postgres psql -U postgres -d stocks_executor_dev \
  -c "SELECT id, symbol, state, close_reason, exit_price FROM trades WHERE reco_id = 1001"
```

- SL order cancelled, SELL order placed, trade state → `CLOSED`

---

## Test Scenario 4: Position Reconciliation

Send `/reconcile` in Telegram.

```bash
docker exec stock_postgres psql -U postgres -d stocks_executor_dev \
  -c "SELECT event, level, payload FROM audit_logs WHERE event LIKE '%RECONCIL%' ORDER BY created_at DESC LIMIT 5"
```

---

## Test Scenario 5: Notification Flow

```bash
# Pending / completed / failed notifications
docker exec stock_redis redis-cli LLEN "bull:notification:waiting"
docker exec stock_redis redis-cli LLEN "bull:notification:completed"
docker exec stock_redis redis-cli LLEN "bull:notification:failed"

# Worker logs
docker compose logs stock_worker --tail 50 | grep -E "NotifWorker|notification"
```

---

## Missing Command: `/closedtrades`

Add to `scheduler.ts`:

```typescript
async runClosedTradesScan(): Promise<string> {
  try {
    await this.executeClosedTradesScan();
    return "✅ Closed trades scan completed — reconciliation jobs enqueued.";
  } catch (err: any) {
    return `❌ Closed trades scan failed: ${err?.message ?? "unknown error"}`;
  }
}
```

Add to `telegramService.ts`:

```typescript
this.bot.command("closedtrades", async (ctx) => {
  ctx.reply("🔄 Running closed trades scan…");
  try {
    const result = await this.scheduler.runClosedTradesScan();
    ctx.reply(result);
  } catch (err: any) {
    ctx.reply(`❌ Error: ${err?.message}`);
  }
});
```

---

## Quick Reference Cheat Sheet

```bash
# ── Mock Server Admin API ──
curl http://localhost:4000/admin/state | jq .                          # View state
curl -X POST http://localhost:4000/admin/signals/reset                  # Reset signals
curl -X POST http://localhost:4000/admin/reset                          # Reset Dhan state
curl -X POST http://localhost:4000/admin/signals/add-active -d '...'   # Add signal
curl -X POST http://localhost:4000/admin/signals/close/1001 -d '...'   # Close signal
curl -X POST http://localhost:4000/admin/trigger-forever/ORD123        # Trigger SL

# ── Redis ──
docker exec stock_redis redis-cli KEYS "bull:*"
docker exec stock_redis redis-cli KEYS "token:*"
docker exec stock_redis redis-cli GET "token:1"

# ── Database ──
docker exec stock_postgres psql -U postgres -d stocks_executor_dev \
  -c "SELECT id, symbol, state, user_id FROM trades ORDER BY created_at DESC LIMIT 10"

# ── Telegram ──
# /trade       → trade scan
# /monitor     → monitoring
# /reconcile   → position reconciliation
# /status      → user status
# /config      → config overrides
```

---

## Full E2E Flow

```
1. docker compose up --build
2. Set token:    redis-cli SET token:1 mock-token-12345
3. Seed signal:  POST /admin/signals/add-active {RELIANCE}
4. /trade      → entry jobs → BUY + SL orders
5. /monitor    → pending → ENTERED
6. /monitor    → check SL/target
7. Close signal: POST /admin/signals/close/1001
8. /closedtrades → cancel SL → SELL → CLOSED
9. /reconcile  → cross-check holdings vs DB
10. Check Telegram → notifications at correct channels
```
