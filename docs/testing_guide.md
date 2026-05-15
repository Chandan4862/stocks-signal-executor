# Manual Testing Guide — Trade Lifecycle

## Prerequisites

| Component              | Status                       | Command to verify                   |
| ---------------------- | ---------------------------- | ----------------------------------- |
| Mock server            | Running on `:4000`           | `curl http://localhost:4000/health` |
| App (`dev:watch`)      | Running                      | Terminal 1                          |
| Workers (`workerMain`) | Running                      | Terminal 2                          |
| User 2                 | ACTIVE, trading_enabled=true | DB check                            |
| Token in Redis         | `token:2` exists             | `redcli GET token:2`                |

```bash
# Quick alias (run once)
alias redcli='/usr/local/bin/docker exec stocks-executor-redis redis-cli'
alias dbcli='/usr/local/bin/docker exec stocks-executor-postgres psql -U postgres -d stocks_executor_dev -c'
```

---

## Phase 1: `/trade` — Place Entry Orders

### What it does

1. Fetches active signals from mock server (`GET /api/active-trades`)
2. For each signal, validates: max trades, max capital, instrument lookup
3. Places a Forever (GTT) BUY order on Dhan (`POST /v2/forever/orders`)
4. Creates trade in DB with state `AWAITING_ENTRY`

### Step 1A: Reset mock server state

```bash
curl -X POST http://localhost:4000/admin/reset
curl -X POST http://localhost:4000/admin/signals/reset
```

### Step 1B: Verify 3 active signals exist

```bash
curl -s http://localhost:4000/admin/signals | python3 -m json.tool | head -5
# Should show: RELIANCE (1001), INFY (1002), TCS (1003)
```

### Step 1C: Clear old idempotency + trades (clean slate)

```bash
dbcli "DELETE FROM reco_scan_log WHERE user_id = 2;"
dbcli "DELETE FROM idempotency WHERE user_id = 2;"
dbcli "DELETE FROM trades WHERE user_id = 2;"
```

### Step 1D: Send `/trade` in Telegram

Send `/trade` to the bot in your DM.

**Expected response:**

```
🔄 Fetching signals and enqueuing trade jobs...
✅ Enqueued 3 trade execution job(s) for 3 signal(s).
```

### Step 1E: Verify

```bash
# Check trades table — 3 rows with AWAITING_ENTRY
dbcli "SELECT id, symbol, state, entry_price, buy_order_id, security_id FROM trades WHERE user_id = 2;"

# Check mock server — 3 forever orders placed
curl -s http://localhost:4000/v2/forever/orders | python3 -m json.tool

# Check Redis — jobs should be completed
redcli ZRANGE "bull:trade-execution:completed" 0 -1

# Check reco_scan_log
dbcli "SELECT reco_id, symbol, outcome, skip_reason FROM reco_scan_log WHERE user_id = 2;"
```

**Expected DB state:**
| symbol | state | buy_order_id |
|---|---|---|
| RELIANCE | AWAITING_ENTRY | 100001 |
| INFY | AWAITING_ENTRY | 100002 |
| TCS | AWAITING_ENTRY | 100003 |

> [!NOTE]
> Order IDs start at 100001 after a mock server reset. Yours may differ if you've already placed orders.

---

## Phase 2: `/monitor` — (Pending Entries Phase)

### What it does (PENDING_ENTRIES)

1. Finds trades with `state = AWAITING_ENTRY` + `buy_order_id` set
2. Checks `GET /v2/forever/orders` for TRIGGERED status
3. If TRIGGERED → checks child order in `GET /v2/orders` → marks ENTERED

### Step 2A: Trigger one forever order (simulate price hit)

Get the forever order IDs from mock server:

```bash
curl -s http://localhost:4000/v2/forever/orders | python3 -c "import sys,json; d=json.load(sys.stdin); [print(f'{o[\"orderId\"]} {o[\"tradingSymbol\"]} {o[\"orderStatus\"]}') for o in d]"
```

Trigger RELIANCE's entry order (replace `100001` with actual order ID):

```bash
curl -X POST http://localhost:4000/admin/trigger-forever/100001
```

**Expected response:**

```json
{ "triggered": true, "foreverOrderId": "100001", "regularOrderId": "100002" }
```

This creates:

- Forever order 100001 → status: TRIGGERED, triggeredOrderId: new regular order
- Regular order (TRADED) with filled price = trigger price
- A holding for RELIANCE in mock server state

### Step 2B: Send `/monitor` in Telegram

Send `/monitor` to the bot.

**Expected response:**

```
✅ Monitor jobs enqueued (pending + entered). Worker will process shortly.
```

### Step 2C: Verify RELIANCE moved to ENTERED

```bash
dbcli "SELECT id, symbol, state, entry_price, quantity, entered_at FROM trades WHERE user_id = 2;"
```

**Expected:**
| symbol | state | entered_at |
|---|---|---|
| RELIANCE | ENTERED | (today's timestamp) |
| INFY | AWAITING_ENTRY | null |
| TCS | AWAITING_ENTRY | null |

---

## Phase 3: `/monitor` — (Entered Trades Phase — Target/SL Exit)

### What it does (ENTERED_TRADES)

1. Finds trades with `state = ENTERED`
2. Fetches `GET /v2/holdings` from Dhan
3. Compares `lastTradedPrice` with target/SL
4. If price ≥ target → Market SELL (TARGET)
5. If price ≤ SL → Market SELL (STOPLOSS)

> [!IMPORTANT]
> `monitorEnteredTrades` **skips same-day entries** (T+1 settlement for CNC). For testing, you need to manually backdate the `entered_at` timestamp.

### Step 3A: Backdate the ENTERED trade (bypass T+1 skip)

```bash
dbcli "UPDATE trades SET entered_at = NOW() - INTERVAL '1 day' WHERE symbol = 'RELIANCE' AND user_id = 2;"
```

### Step 3B: Set the holding's LTP to trigger target or SL

Check what target/SL the trade has:

```bash
dbcli "SELECT symbol, target, sl_trigger FROM trades WHERE symbol = 'RELIANCE' AND user_id = 2;"
```

This should show: target = 2650, sl_trigger = 2380.

**Option A — Trigger TARGET** (set LTP ≥ 2650):

```bash
curl -X POST http://localhost:4000/admin/signals -H 'Content-Type: application/json' -d '{}'
# We need an admin endpoint to set holding LTP. See workaround below.
```

The mock server doesn't have an endpoint to update holding LTP. Let's add one quickly, OR we can manipulate it via the state. Let me give you a `curl` to directly update mock state:

Actually, looking at the mock server `triggerForeverOrder`, it sets `lastTradedPrice = triggerPrice * 1.02`. For RELIANCE with entry_price 2460, `lastTradedPrice ≈ 2509`.

Since target is 2650 and SL is 2380, the LTP (2509) is inside the range → no sell yet. We need a way to push LTP above target.

### Step 3B (alternative): Add a holdings admin endpoint

Add this call to set a holding's LTP (the mock server needs this endpoint):

```bash
# POST to admin to update holding LTP
curl -X POST http://localhost:4000/admin/holding-ltp \
  -H 'Content-Type: application/json' \
  -d '{"securityId": "2885", "lastTradedPrice": 2700}'
```

> [!WARNING]
> The admin endpoint for `/admin/holding-ltp` **does not exist yet** in the mock server.  
> See [Adding the missing endpoint](#adding-admin-holding-ltp-endpoint) below.

### Step 3C: Send `/monitor` again

```bash
# After setting LTP above target
```

Send `/monitor` in Telegram.

### Step 3D: Verify SELL executed

```bash
# Trade should be CLOSED now
dbcli "SELECT id, symbol, state, sell_order_id, exited_at FROM trades WHERE symbol = 'RELIANCE' AND user_id = 2;"

# PnL record should exist
dbcli "SELECT * FROM pnl_records WHERE user_id = 2;"

# Mock server should have a SELL order
curl -s http://localhost:4000/v2/orders | python3 -c "import sys,json; d=json.load(sys.stdin); [print(f'{o[\"orderId\"]} {o[\"transactionType\"]} {o[\"tradingSymbol\"]} {o[\"orderStatus\"]}') for o in d]"
```

---

## Phase 4: `/closedtrades` — Analyst Closes a Signal

### What it does

1. Fetches closed signals from mock server (`GET /api/closed-trades`)
2. Matches by `reco_id` to local trades
3. AWAITING_ENTRY → cancels forever order → CLOSED
4. ENTERED → Market SELL → CLOSED_BY_ANALYST

### Step 4A: Close INFY signal via admin API

```bash
# Close signal 1002 (INFY) — moves from active to closed
curl -X POST http://localhost:4000/admin/signals/close/1002
```

### Step 4B: Trigger INFY's forever order first (simulate it entered)

If you want to test the ENTERED path:

```bash
# Get INFY's forever order ID
curl -s http://localhost:4000/v2/forever/orders | python3 -c "import sys,json; d=json.load(sys.stdin); [print(f'{o[\"orderId\"]} {o[\"tradingSymbol\"]} {o[\"orderStatus\"]}') for o in d]"

# Trigger it (replace 100002 with actual ID)
curl -X POST http://localhost:4000/admin/trigger-forever/100002

# Run /monitor first to mark it ENTERED
# (send /monitor in Telegram, then backdate entered_at)
dbcli "UPDATE trades SET entered_at = NOW() - INTERVAL '1 day' WHERE symbol = 'INFY' AND user_id = 2;"
```

If you want to test the AWAITING_ENTRY path, skip triggering — just leave INFY as AWAITING_ENTRY.

### Step 4C: Send `/closedtrades` in Telegram

**Expected response:**

```
🔄 Fetching closed trade signals...
✅ Found 2 closed signal(s). Reconciliation job enqueued.
```

(2 because HDFCBANK is in defaults + INFY you just closed)

### Step 4D: Verify

```bash
# INFY should be CLOSED or CLOSED_BY_ANALYST depending on state
dbcli "SELECT id, symbol, state, sell_order_id FROM trades WHERE symbol = 'INFY' AND user_id = 2;"
```

---

## Phase 5: `/reconcile` — Position Reconciliation

### What it does

- **Path A:** AWAITING_ENTRY + holding exists → mark ENTERED (server-was-down recovery)
- **Path B:** ENTERED + no holding → mark CLOSED (manual exit from Dhan app)
- **Path C:** AWAITING_ENTRY + no holding + forever order gone → CANCELLED
- **Path D:** ENTERED + holding + stale sell_order_id → clear and retry

### Step 5A: Test Path B (ENTERED but holding removed)

```bash
# First, trigger TCS and monitor it to ENTERED state
# (use the steps from Phase 2-3 for TCS)

# Then reset mock server to clear holdings (simulates manual exit)
curl -X POST http://localhost:4000/admin/reset

# Backdate entered_at for TCS
dbcli "UPDATE trades SET entered_at = NOW() - INTERVAL '1 day' WHERE symbol = 'TCS' AND user_id = 2 AND state = 'ENTERED';"
```

### Step 5B: Send `/reconcile` in Telegram

**Expected response:**

```
✅ Reconciliation job enqueued. Worker will cross-check your holdings.
```

### Step 5C: Verify

```bash
dbcli "SELECT id, symbol, state, exited_at FROM trades WHERE symbol = 'TCS' AND user_id = 2;"
# Should be CLOSED with exited_at set
```

You should also receive a Telegram notification:

```
⚠️ Position Reconciled
Symbol: TCS
Was ENTERED locally but no Dhan holding found.
Marked CLOSED (likely manual exit from Dhan app).
```

---

## Adding `admin/holding-ltp` Endpoint

Add this to `mock-server/src/dhan.routes.ts` before the admin/reset route:

```typescript
/** POST /admin/holding-ltp — Update a holding's last traded price */
router.post("/admin/holding-ltp", (req, res) => {
  const { securityId, lastTradedPrice } = req.body;
  const holding = store.holdings.get(String(securityId));
  if (!holding) {
    return res.status(404).json({ error: "Holding not found", securityId });
  }
  holding.lastTradedPrice = lastTradedPrice;
  holding.pnl = (lastTradedPrice - holding.avgCostPrice) * holding.totalQty;
  console.log(`  📊 Holding LTP updated: ${holding.tradingSymbol} → ₹${lastTradedPrice}`);
  res.json({ updated: true, symbol: holding.tradingSymbol, lastTradedPrice });
});
```

---

## Quick Reference: Instrument Security IDs

| Symbol   | security_id | Entry Price (Mock Signal) | Target | SL   |
| -------- | ----------- | ------------------------- | ------ | ---- |
| RELIANCE | 2885        | 2460                      | 2650   | 2380 |
| INFY     | 1594        | 1470-1500                 | 1620   | 1420 |
| TCS      | 11536       | 3750                      | 4100   | 3580 |

> [!NOTE]
> The `sc_id` in mock signals does NOT match the DB security_id. The app resolves security_id from `instrument_list_nse_eq` using `sc_symbol`, not `sc_id`.

---

## Redis Inspection Commands

```bash
# Jobs in each state
redcli LRANGE "bull:trade-execution:wait" 0 -1
redcli LRANGE "bull:trade-execution:active" 0 -1
redcli ZRANGE "bull:trade-execution:completed" 0 -1
redcli ZRANGE "bull:trade-execution:failed" 0 -1

# Same for other queues (replace trade-execution with queue name)
# trade-monitor, trade-reconciliation, notification, token-renewal

# Check specific job data
redcli HGETALL "bull:trade-execution:<jobId>"

# Token status
redcli GET "token:2"
redcli TTL "token:2"
```

---

## Phase 6: IP Whitelisting Integration

### What it does

The IP whitelist system ensures that your infrastructure's IP address is actively registered with Dhan before any API requests (orders, holdings, etc.) are processed. It features an inline sync during `/enable`, manual syncs, and defensive gating.

### Step 6A: View Current IP Status

Send `/ip_status` in Telegram.

**Expected response:**

```
📡 IP Whitelist Status

No IP whitelist data yet.
Run /ip_sync to perform initial sync with Dhan.
```

_(If you have already synced via `/enable`, it will show the IP details and the cooldown periods.)_

### Step 6B: Trigger Manual Sync

Send `/ip_sync` in Telegram.

**Expected response:**

```
🔄 IP sync job enqueued.
Worker will check and fix your IP whitelist shortly.
```

### Step 6C: Verify DB & Cache

Check the database to see the sync result:

```bash
dbcli "SELECT user_id, primary_ip, detected_ip, ip_match_status, orders_allowed FROM ip_whitelist WHERE user_id = 2;"
```

Send `/ip_status` again to view the populated state. It should show:

- `Orders Allowed: ✅ Yes`
- `IP Match: PRIMARY_MATCH` (or `SECONDARY_MATCH`)

### Step 6D: Trigger Admin Bulk Sync

Send `/ip_whitelist_all` in Telegram (must be sent from the configured admin chat ID).

**Expected response:**

```
✅ Enqueued 1 IP sync job(s) for active users.
Worker will process each user's IP whitelist.
```

### Step 6E: Verify IP Gate Execution

Whenever a worker (like trade, monitor, or reconcile) executes, it will first hit `assertOrdersAllowed` in the `IpWhitelistService`.
You can verify this by checking Redis for the cached IP status:

```bash
redcli GET "ip:status:2"
```

If the cached IP status shows `"ordersAllowed": true`, all order operations will seamlessly continue without making extra API calls.
