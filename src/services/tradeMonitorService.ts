/*
  TradeMonitorService: Phase 3 + 5 — Monitor pending entries and entered trades.

  Phase 3 (monitorPendingEntries):
  Checks forever orders for TRIGGERED status, then looks up child orders
  in /orders via algoId to determine if entry was TRADED or REJECTED.

  Phase 5 (monitorEnteredTrades):
  Checks exit OCO forever orders for TRIGGERED status, then looks up child
  SELL orders to determine if exit was TRADED, REJECTED, or CANCELLED.
*/

import type { AppConfig } from "../config/schema";
import { DhanService, DhanApiError } from "./dhanService";
import { StateStore } from "./stateStore";
import { AuditLogService } from "./auditLogService";
import { LifecycleEvents } from "../enums/trade";
import { TradeHelpers } from "./tradeHelpers";

export class TradeMonitorService {
  constructor(private cfg: AppConfig) {}

  // Phase 3: Monitor pending Forever Orders — handle TRIGGERED status
  // ┌─────────────────────────────────────────────────────────────────┐
  // │  monitorPendingEntries (runs on polling interval)               │
  // │                                                                 │
  // │  Dhan Forever Orders return: PENDING | TRIGGERED                │
  // │  When TRIGGERED, a child regular order is created in /orders    │
  // │  The child order has algoId = forever order's orderId           │
  // │                                                                 │
  // │  1. GET /forever/orders → find TRIGGERED orders                 │
  // │  2. GET /orders → find child order by algoId                    │
  // │     ├─ TRADED   → place OCO exit, update to ENTERED             │
  // │     ├─ REJECTED → mark CANCELLED, notify with reason            │
  // │     └─ PENDING  → still executing, wait                         │
  // └─────────────────────────────────────────────────────────────────┘
  async monitorPendingEntries(
    store: StateStore,
    dhan: DhanService,
    audit: AuditLogService,
  ): Promise<void> {
    try {
      // 1. Query Postgres for trades in AWAITING_ENTRY state
      const pendingRes = await store.pg.query(
        `SELECT * FROM trades WHERE state = 'AWAITING_ENTRY' AND buy_order_id IS NOT NULL`,
      );
      if (pendingRes.rows.length === 0) return;

      // 2. Fetch forever orders and regular orders from Dhan
      const foreverOrders = await dhan.getForeverOrders();
      if (!Array.isArray(foreverOrders)) return;
      const regularOrders = await dhan.getOrders();

      for (const tradeRow of pendingRes.rows) {
        // 3. Find the corresponding forever order
        const foreverOrder = TradeHelpers.findForeverOrder(
          foreverOrders,
          tradeRow.buy_order_id,
        );

        if (!foreverOrder) continue;

        if (foreverOrder.orderStatus === "TRIGGERED") {
          // Forever order triggered — find the child regular order
          // Child order's algoId = forever order's orderId
          const childOrder = TradeHelpers.findChildOrder(
            regularOrders,
            tradeRow.buy_order_id,
          );

          if (!childOrder) {
            // Child order not yet visible in /orders — wait for next tick
            continue;
          }

          if (childOrder.orderStatus === "TRADED") {
            // Entry confirmed! Place OCO exit.
            const tradedPrice = TradeHelpers.resolveChildPrice(
              childOrder,
              Number(tradeRow.entry_price),
            );

            await TradeHelpers.placeOcoExitAndEnter(this.cfg, {
              store,
              dhan,
              audit,
              tradeRow,
              entryPrice: tradedPrice,
              quantity: tradeRow.quantity,
              source: "monitorPendingEntries",
            });
          } else if (childOrder.orderStatus === "REJECTED") {
            // Child order rejected (e.g. insufficient funds)
            const reason =
              childOrder.omsErrorDescription || "Unknown rejection reason";

            await store.pg.query(
              `UPDATE trades SET state = 'CANCELLED' WHERE id = $1`,
              [tradeRow.id],
            );

            await audit.warn(LifecycleEvents.ERROR_OCCURRED, {
              id: tradeRow.id,
              action: "Entry child order REJECTED",
              orderStatus: childOrder.orderStatus,
              childOrderId: childOrder.orderId,
              reason,
            });

            await audit.notify(
              `⛔ Entry REJECTED\n` +
                `Symbol: ${tradeRow.symbol}\n` +
                `Order: ${childOrder.orderId}\n` +
                `Reason: ${reason}`,
            );
          }
          // If child is PENDING/TRANSIT → still executing, wait for next tick
        } else if (
          foreverOrder.orderStatus === "CANCELLED" ||
          foreverOrder.orderStatus === "EXPIRED"
        ) {
          await store.pg.query(
            `UPDATE trades SET state = 'CANCELLED' WHERE id = $1`,
            [tradeRow.id],
          );
          await audit.warn(LifecycleEvents.ERROR_OCCURRED, {
            id: tradeRow.id,
            action: `Entry Forever Order ${foreverOrder.orderStatus}`,
          });

          await audit.notify(
            `⛔ Entry ${foreverOrder.orderStatus}\n` +
              `Symbol: ${tradeRow.symbol}\n` +
              `Order: ${tradeRow.buy_order_id}`,
          );
        }
        // PENDING → trigger not yet hit, wait
      }
    } catch (err: any) {
      await audit.error(LifecycleEvents.ERROR_OCCURRED, {
        action: "monitorPendingEntries",
        error: err.message,
      });
    }
  }

  // Phase 5: Monitor ENTERED trades — check if exit OCO has triggered
  // ┌───────────────────────────────────────────────────────────────────┐
  // │  monitorEnteredTrades (runs on polling interval)                  │
  // │                                                                   │
  // │  Exit orders are Forever OCO orders.                              │
  // │  When triggered, child SELL order appears in /orders              │
  // │  with algoId = forever exit order's orderId                       │
  // │                                                                   │
  // │  1. SELECT trades WHERE state = 'ENTERED'                         │
  // │  2. Check /forever/orders for exit order status                   │
  // │     ├─ TRIGGERED → check /orders child by algoId                  │
  // │     │   ├─ TRADED   → CLOSED + PnL                                │
  // │     │   └─ REJECTED → alert UNPROTECTED                           │
  // │     ├─ CANCELLED/EXPIRED → alert UNPROTECTED                      │
  // │     └─ PENDING → still waiting                                    │
  // └───────────────────────────────────────────────────────────────────┘

  // Trade in ENTERED state (we own the stock, OCO exit placed)
  //   │
  //   monitorEnteredTrades() runs hourly
  //   │
  //   ├── 1. Get all ENTERED trades from DB (with exit_order_id)
  //   ├── 2. Fetch /forever/orders + /orders from Dhan
  //   │
  //   └── 3. For each trade, find exit forever order:
  //         │
  //         ├── PENDING → OCO hasn't triggered yet → do nothing, wait
  //         │
  //         ├── TRIGGERED → OCO fired! Check child SELL order in /orders:
  //         │     │
  //         │     ├── TRADED → Exit confirmed!
  //         │     │   → UPDATE state = 'CLOSED'
  //         │     │   → Record PnL in pnl_records
  //         │     │   → "🟢 EXIT Triggered — Position Closed"
  //         │     │
  //         │     ├── REJECTED → Exit failed (e.g. insufficient qty)
  //         │     │   → "🚨 EXIT REJECTED — Position UNPROTECTED"
  //         │     │   → Manual action needed
  //         │     │
  //         │     └── PENDING/TRANSIT → still executing, wait
  //         │
  //         ├── CANCELLED → someone cancelled the OCO on Dhan app
  //         │   → "🚨 EXIT ORDER CANCELLED — Position UNPROTECTED"
  //         │
  //         └── EXPIRED → OCO expired
  //             → "🚨 EXIT ORDER EXPIRED — Position UNPROTECTED"

  async monitorEnteredTrades(
    store: StateStore,
    dhan: DhanService,
    audit: AuditLogService,
  ): Promise<void> {
    try {
      const enteredRes = await store.pg.query(
        `SELECT * FROM trades WHERE state = 'ENTERED' AND exit_order_id IS NOT NULL`,
      );
      if (enteredRes.rows.length === 0) return;

      // Batch fetch all orders
      const foreverOrders = await dhan.getForeverOrders();
      const regularOrders = await dhan.getOrders();

      for (const tradeRow of enteredRes.rows) {
        // Find exit forever order
        const exitForever = TradeHelpers.findForeverOrder(
          foreverOrders,
          tradeRow.exit_order_id,
        );

        if (!exitForever) {
          // Exit order not found in forever list — might have been deleted/expired
          continue;
        }

        if (exitForever.orderStatus === "TRIGGERED") {
          // OCO triggered — find child SELL order
          const childOrder = TradeHelpers.findChildOrder(
            regularOrders,
            tradeRow.exit_order_id,
          );

          if (!childOrder) continue; // Not yet visible

          if (childOrder.orderStatus === "TRADED") {
            // Exit confirmed! Position closed.
            const exitPrice = TradeHelpers.resolveChildPrice(
              childOrder,
              Number(tradeRow.entry_price),
            );

            await store.pg.query(
              `UPDATE trades SET state = 'CLOSED', exited_at = NOW(), exit_price = $1 WHERE id = $2`,
              [exitPrice, tradeRow.id],
            );

            await TradeHelpers.recordPnl(store, tradeRow, exitPrice);

            const entryPrice = Number(tradeRow.entry_price);
            const pnl = (exitPrice - entryPrice) * tradeRow.quantity;
            const pnlSign = pnl >= 0 ? "+" : "";
            const emoji = pnl >= 0 ? "🟢" : "🔴";

            await audit.info(LifecycleEvents.SELL_PLACED, {
              id: tradeRow.id,
              message: "Exit TRADED. Position closed.",
              exitPrice,
              childOrderId: childOrder.orderId,
              pnl,
            });

            await audit.notify(
              `${emoji} EXIT Triggered — Position Closed\n` +
                `Symbol: ${tradeRow.symbol}\n` +
                `Entry: ₹${entryPrice} → Exit: ₹${exitPrice}\n` +
                `Qty: ${tradeRow.quantity} | PnL: ${pnlSign}₹${pnl.toFixed(2)}`,
            );
          } else if (childOrder.orderStatus === "REJECTED") {
            // Exit rejected — position UNPROTECTED
            const reason =
              childOrder.omsErrorDescription || "Unknown rejection reason";

            await audit.critical(LifecycleEvents.ERROR_OCCURRED, {
              id: tradeRow.id,
              action: "monitorEnteredTrades",
              error: `Exit child order REJECTED — position UNPROTECTED!`,
              exitOrderId: tradeRow.exit_order_id,
              childOrderId: childOrder.orderId,
              symbol: tradeRow.symbol,
              reason,
            });

            await audit.notify(
              `🚨 EXIT REJECTED — Position UNPROTECTED\n` +
                `Symbol: ${tradeRow.symbol}\n` +
                `Qty: ${tradeRow.quantity}\n` +
                `Reason: ${reason}\n` +
                `Manual action required.`,
            );
          }
        } else if (
          exitForever.orderStatus === "CANCELLED" ||
          exitForever.orderStatus === "EXPIRED"
        ) {
          // Exit order cancelled/expired — position UNPROTECTED
          await audit.critical(LifecycleEvents.ERROR_OCCURRED, {
            id: tradeRow.id,
            action: "monitorEnteredTrades",
            error: `Exit forever order ${exitForever.orderStatus} — position UNPROTECTED!`,
            exitOrderId: tradeRow.exit_order_id,
            symbol: tradeRow.symbol,
          });

          await audit.notify(
            `🚨 EXIT ORDER ${exitForever.orderStatus}\n` +
              `Symbol: ${tradeRow.symbol}\n` +
              `Qty: ${tradeRow.quantity} — Position UNPROTECTED!\n` +
              `Manual action required.`,
          );
        }
        // PENDING → OCO not yet triggered, wait
      }
    } catch (err: any) {
      await audit.error(LifecycleEvents.ERROR_OCCURRED, {
        action: "monitorEnteredTrades",
        error: err?.message ?? String(err),
      });
    }
  }
}
