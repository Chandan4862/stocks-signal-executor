/*
  TradeMonitorService: Monitor pending entries and entered trades.

  monitorPendingEntries:
  Checks forever orders for TRIGGERED status, then looks up child orders
  in /orders via algoId to determine if entry was TRADED or REJECTED.
  On TRADED: marks ENTERED (no OCO exit order).

  monitorEnteredTrades:
  Checks /holdings for ENTERED trades (skips same-day entries).
  Compares lastTradedPrice with target/sl.
  If outside range: places Market SELL via placeSellAndClose().
*/

import type { AppConfig } from "../config/schema";
import { DhanService, DhanApiError } from "./dhanService";
import { StateStore } from "./stateStore";
import { AuditLogService } from "./auditLogService";
import { LifecycleEvents, TradeState } from "../enums/trade";
import { TradeHelpers } from "./tradeHelpers";

export class TradeMonitorService {
  constructor(private cfg: AppConfig) {}

  // ┌───────────────────────────────────────────────────────────────────┐
  // │  monitorPendingEntries (runs hourly during market hours)          │
  // │                                                                   │
  // │  1. GET /forever/orders → find order for each AWAITING_ENTRY      │
  // │  2. If TRIGGERED → GET /orders → find child by algoId             │
  // │     ├─ TRADED     → markEntered (no OCO)                          │
  // │     ├─ REJECTED   → CANCELLED + reason                            │
  // │     ├─ CANCELLED  → CANCELLED + reason                            │
  // │     └─ PENDING    → wait                                          │
  // │  3. If no forever order found → fallback: check /orders (S5)      │
  // │  4. If CANCELLED/EXPIRED → CANCELLED                              │
  // │  5. If PENDING → wait                                             │
  // └───────────────────────────────────────────────────────────────────┘
  async monitorPendingEntries(
    store: StateStore,
    dhan: DhanService,
    audit: AuditLogService,
    userId?: number,
  ): Promise<void> {
    try {
      const userFilter = userId ? ` AND user_id = ${userId}` : "";
      const pendingRes = await store.pg.query(
        `SELECT * FROM trades WHERE state = '${TradeState.AWAITING_ENTRY}' AND buy_order_id IS NOT NULL${userFilter}`,
      );
      if (pendingRes.rows.length === 0) return;

      const foreverOrders = await dhan.getForeverOrders();
      if (!Array.isArray(foreverOrders)) return;
      const regularOrders = await dhan.getOrders();

      for (const tradeRow of pendingRes.rows) {
        const foreverOrder = TradeHelpers.findForeverOrder(foreverOrders, tradeRow.buy_order_id);

        if (foreverOrder) {
          // Forever order found — check its status
          if (foreverOrder.orderStatus === "TRIGGERED") {
            await this.handleTriggeredEntry(store, dhan, audit, tradeRow, regularOrders);
          } else if (
            foreverOrder.orderStatus === "CANCELLED" ||
            foreverOrder.orderStatus === "EXPIRED"
          ) {
            await this.markCancelled(
              store,
              audit,
              tradeRow,
              `Entry Forever Order ${foreverOrder.orderStatus}`,
            );
          }
          // PENDING → trigger not yet hit, wait
        } else {
          // S5: No forever order found — check /orders for TRADED child (startup recovery)
          // This catches entries that triggered while server was down and
          // /forever/orders no longer shows TRIGGERED.
          const childOrder = TradeHelpers.findChildOrder(regularOrders, tradeRow.buy_order_id);

          if (childOrder && childOrder.orderStatus === "TRADED") {
            const tradedPrice = TradeHelpers.resolveChildPrice(
              childOrder,
              Number(tradeRow.entry_price),
            );
            const qty = childOrder.filledQty || tradeRow.quantity;

            await TradeHelpers.markEntered(
              store,
              audit,
              tradeRow,
              tradedPrice,
              qty,
              "monitorPendingEntries — S5 child order recovery",
            );
          }
          // else: no forever order AND no child order — might have been deleted, wait for reconciliation
        }
      }
    } catch (err: any) {
      await audit.error(LifecycleEvents.ERROR_OCCURRED, {
        action: "monitorPendingEntries",
        error: err.message,
      });
    }
  }

  // ┌───────────────────────────────────────────────────────────────────┐
  // │  monitorEnteredTrades (runs hourly during market hours)           │
  // │                                                                   │
  // │  1. SELECT ENTERED trades, skip same-day entries (T+1)            │
  // │  2. GET /holdings                                                 │
  // │  3. Match by tradingSymbol                                        │
  // │     ├─ lastTradedPrice >= target → SELL (TARGET)                  │
  // │     ├─ lastTradedPrice <= sl     → SELL (STOPLOSS)                │
  // │     └─ Inside range              → do nothing                     │
  // │  4. Place Market SELL via placeSellAndClose()                      │
  // │     ├─ Success → CLOSED + PnL                                     │
  // │     └─ Failure → log + notify, stay ENTERED (retry next tick)     │
  // └───────────────────────────────────────────────────────────────────┘
  async monitorEnteredTrades(
    store: StateStore,
    dhan: DhanService,
    audit: AuditLogService,
    userId?: number,
  ): Promise<void> {
    try {
      const userFilter = userId ? ` AND user_id = ${userId}` : "";
      const enteredRes = await store.pg.query(
        `SELECT * FROM trades WHERE state = '${TradeState.ENTERED}'${userFilter}`,
      );
      if (enteredRes.rows.length === 0) return;

      const holdings = await dhan.getHoldings();
      if (!Array.isArray(holdings)) return;

      const today = new Date().toDateString();

      for (const tradeRow of enteredRes.rows) {
        // Skip same-day entries — CNC holdings only visible after T+1 settlement
        if (tradeRow.entered_at) {
          const enteredDate = new Date(tradeRow.entered_at).toDateString();
          if (enteredDate === today) continue;
        }

        // Skip trades with sell_order_id already set (sell in progress)
        if (tradeRow.sell_order_id) continue;

        // Find matching holding by tradingSymbol
        const holding = holdings.find(
          (h) => String(h.tradingSymbol).toUpperCase() === String(tradeRow.symbol).toUpperCase(),
        );

        if (!holding || holding.totalQty <= 0) continue;

        const lastTradedPrice = Number(holding.lastTradedPrice);
        if (!lastTradedPrice || lastTradedPrice <= 0) continue;

        // Persist LTP on every tick for live tracking
        await store.pg.query(`UPDATE trades SET ltp = $1 WHERE id = $2`, [
          lastTradedPrice,
          tradeRow.id,
        ]);

        const target = Number(tradeRow.target) || null;
        const sl = Number(tradeRow.sl_trigger) || null;

        const sellReason = TradeHelpers.shouldSell(lastTradedPrice, target, sl);
        if (!sellReason) continue;

        // Price outside range — place Market SELL
        await TradeHelpers.placeSellAndClose(this.cfg, {
          store,
          dhan,
          audit,
          tradeRow,
          exitPrice: lastTradedPrice,
          source: `monitorEnteredTrades — ${sellReason}`,
        });
      }
    } catch (err: any) {
      await audit.error(LifecycleEvents.ERROR_OCCURRED, {
        action: "monitorEnteredTrades",
        error: err?.message ?? String(err),
      });
    }
  }

  // ─── Private Helpers ──────────────────────────────────────────────

  /**
   * Handle a TRIGGERED forever entry: look up child order, act on status.
   */
  private async handleTriggeredEntry(
    store: StateStore,
    dhan: DhanService,
    audit: AuditLogService,
    tradeRow: any,
    regularOrders: any[],
  ): Promise<void> {
    const childOrder = TradeHelpers.findChildOrder(regularOrders, tradeRow.buy_order_id);

    if (!childOrder) {
      // Child order not yet visible in /orders — wait for next tick
      return;
    }

    if (childOrder.orderStatus === "TRADED") {
      const tradedPrice = TradeHelpers.resolveChildPrice(childOrder, Number(tradeRow.entry_price));
      const qty = childOrder.filledQty || tradeRow.quantity;

      await TradeHelpers.markEntered(
        store,
        audit,
        tradeRow,
        tradedPrice,
        qty,
        "monitorPendingEntries",
      );
    } else if (childOrder.orderStatus === "REJECTED" || childOrder.orderStatus === "CANCELLED") {
      const reason = childOrder.omsErrorDescription || `Child order ${childOrder.orderStatus}`;

      await this.markCancelled(store, audit, tradeRow, reason);
    }
    // PENDING/TRANSIT → still executing, wait
  }

  /**
   * Mark a trade as CANCELLED with a reason notification.
   */
  private async markCancelled(
    store: StateStore,
    audit: AuditLogService,
    tradeRow: any,
    reason: string,
  ): Promise<void> {
    await store.pg.query(`UPDATE trades SET state = '${TradeState.CANCELLED}' WHERE id = $1`, [
      tradeRow.id,
    ]);

    await audit.warn(LifecycleEvents.ERROR_OCCURRED, {
      id: tradeRow.id,
      action: "monitorPendingEntries",
      reason,
    });

    await audit.notify(
      `⛔ Entry CANCELLED\n` + `Symbol: ${tradeRow.symbol}\n` + `Reason: ${reason}`,
    );
  }
}
