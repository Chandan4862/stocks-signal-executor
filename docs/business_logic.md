# Trade Logic Revamp — Remove OCO, Holdings-Based SELL

Remove OCO Forever orders for exits. Use `/holdings` `lastTradedPrice` to decide when to sell, placing regular Market SELL orders directly.

> [!IMPORTANT]
> **Same-day entries will NOT auto-sell.** CNC holdings only appear after T+1 settlement.

> [!IMPORTANT]
> **New DB column `sell_order_id`** on `trades` table prevents duplicate sells.

---

## Flow

```
RunBuy (09:30 IST, once/day)
  └─ Scan active API → place Forever BUY → AWAITING_ENTRY

Monitor (hourly: 10:00–15:00 IST)
  ├─ Step 1: AWAITING_ENTRY trades
  │   ├─ /forever/orders TRIGGERED + /orders child TRADED → markEntered
  │   ├─ TRIGGERED + child REJECTED/CANCELLED → CANCELLED
  │   ├─ No forever order found → check /orders for TRADED child (S5 recovery)
  │   ├─ CANCELLED/EXPIRED → CANCELLED
  │   └─ PENDING → wait
  │
  └─ Step 2: ENTERED trades (skip same-day)
      ├─ /holdings match by tradingSymbol
      │   ├─ lastTradedPrice >= target OR <= sl → atomic sell guard → Market SELL
      │   │   ├─ Success → record PnL → CLOSED
      │   │   └─ Failure → log + notify, stay ENTERED (retry next tick)
      │   └─ Inside range → do nothing
      └─ No holding → do nothing (reconciliation handles)

ProcessClosedTrades (15:00 IST)
  └─ Match by reco_id (fallback: symbol)
      ├─ AWAITING_ENTRY → cancel Forever BUY → CLOSED
      └─ ENTERED → atomic sell guard → Market SELL → CLOSED_BY_ANALYST

Reconciliation (16:00 IST, after market)
  ├─ Path A: AWAITING_ENTRY + holding → markEntered
  ├─ Path B: ENTERED + no holding → CLOSED (no further checks)
  ├─ Path C: AWAITING_ENTRY + no holding + forever gone → CANCELLED
  └─ Path D: ENTERED + holding + sell_order_id set
      → notify on Telegram to manually exit, do NOT change state
      → on next iteration if user closes, it gets marked CLOSED
```

---

## Safeguards

| #   | Safeguard            | How                                                                                                     |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------- |
| S1  | Atomic sell guard    | `UPDATE trades SET sell_order_id=$1 WHERE id=$2 AND sell_order_id IS NULL RETURNING id` — 0 rows = skip |
| S3  | Pre-sell persistence | Write `sell_order_id='pending_{id}'` before API call, update on success, clear on failure               |
| S4  | Symbol fallback      | processClosedTrades: if `reco_id` match fails, try `symbol` + active state                              |
| S5  | Startup recovery     | monitorPendingEntries: if no forever order, check `/orders` for TRADED child by `algoId`                |

---

- Monitor: `["10:00", "11:00", "12:00", "13:00", "14:00", "15:00"]`
- Trade scan (09:30): only Phase 2 (RunBuy)
- New `executeClosedTradesScan()` at 15:00
- Reconciliation stays at 16:00

---

### DB Migration

```sql
ALTER TABLE trades ADD COLUMN IF NOT EXISTS sell_order_id TEXT DEFAULT NULL;
```

---

## Verification

```bash
npx vitest run tests/processClosedTrades.test.ts 2>&1
npx vitest run tests/tradeMonitor.test.ts 2>&1
```

Key scenarios: atomic sell guard prevents duplicates, same-day skip, reco_id + symbol fallback, startup recovery, Path D telegram notification only.

## State Machine

                    TradeEntryService
                    ┌──────────────┐
                    │  RunBuy      │
        ┌───────────┤  INSERT →    ├─────────────┐
        │           │AWAITING_ENTRY│             │
        │           └──────────────┘             │
        ▼                                        ▼

┌─── AWAITING_ENTRY ───────────────────────────────────────────┐
│ │
│ Writers: │
│ • monitorPendingEntries → ENTERED (TRIGGERED+TRADED) │
│ • monitorPendingEntries → CANCELLED (TRIGGERED+REJECTED) │
│ • monitorPendingEntries → CANCELLED (forever CANCELLED) │
│ • monitorPendingEntries → ENTERED (S5 child recovery) │
│ • processClosedTrades → CLOSED (analyst closed) │
│ • reconcilePositions A → ENTERED (holding found) │
│ • reconcilePositions C → ENTERED (child order recovery) │
│ • reconcilePositions C → CANCELLED (stale, no holding) │
└──────────────────────────────────────────────────────────────┘
│ │
▼ ▼
┌─── ENTERED ────────────────────────────────────────────────┐
│ │
│ Writers: │
│ • monitorEnteredTrades → CLOSED (target/SL via holdings) │
│ • processClosedTrades → CLOSED_BY_ANALYST │
│ • reconcilePositions B → CLOSED (no holding found) │
│ • reconcilePositions D → (no change, notify only) │
└────────────────────────────────────────────────────────────┘
│ │ │
▼ ▼ ▼
CLOSED CLOSED_BY_ANALYST CANCELLED
(terminal) (terminal) (terminal)
