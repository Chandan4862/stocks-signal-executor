/*
  TradeReconciliationService: Phase 4 + 6 — Handle external closures
  and reconcile Dhan holdings with local trade state.

  Phase 4 (processClosedTrades):
  When an analyst closes a trade on the external platform, cancel pending
  orders and liquidate positions.

  Phase 6 (reconcilePositions):
  Three reconciliation paths:
   A. AWAITING_ENTRY + holding exists → entry happened while server was down
   B. ENTERED + no holding → exit happened outside our knowledge
   C. AWAITING_ENTRY + no holding + forever order not PENDING
      → entry was rejected/expired while server was down
*/

import type { AppConfig } from "../config/schema";
import {
  DhanService,
  DhanApiError,
  PlaceOrderRequest,
} from "./dhanService";
import { StateStore } from "./stateStore";
import { AuditLogService } from "./auditLogService";
import { LifecycleEvents } from "../enums/trade";
import { TradeHelpers } from "./tradeHelpers";
import type { ClosedTrade } from "../models/closedTrade";

export class TradeReconciliationService {
  constructor(private cfg: AppConfig) {}

  // Phase 4: Handle External Closures via Closed Trades API
  async processClosedTrades(
    store: StateStore,
    dhan: DhanService,
    audit: AuditLogService,
    closedTrades: ClosedTrade[],
  ): Promise<void> {
    try {
      for (const ct of closedTrades) {
        // Check if this trade exists in our local tracker
        const tradeRes = await store.pg.query(
          `SELECT * FROM trades WHERE id = $1`,
          [ct.id],
        );
        if (tradeRes.rows.length === 0) continue;

        const tradeRow = tradeRes.rows[0];

        // If the trade is already closed locally, do nothing
        if (
          tradeRow.state === "CLOSED" ||
          tradeRow.state === "CLOSED_BY_ANALYST"
        )
          continue;

        // Let's cancel whatever is pending and clear it out
        if (tradeRow.state === "AWAITING_ENTRY") {
          try {
            if (tradeRow.buy_order_id) {
              await dhan.cancelForeverOrder(tradeRow.buy_order_id);
            }
            await store.pg.query(
              `UPDATE trades SET state = 'CLOSED' WHERE id = $1`,
              [ct.id],
            );
            await audit.info(LifecycleEvents.SKIP_TRADE, {
              id: ct.id,
              message:
                "Trade closed by analyst before entry executed. Cancelled pending Forever order.",
            });

            await audit.notify(
              `🔄 Trade Closed (Pre-Entry)\n` +
                `Symbol: ${tradeRow.symbol}\n` +
                `Analyst closed before entry triggered. Pending order cancelled.`,
            );
          } catch (err: any) {
            await audit.error(LifecycleEvents.ERROR_OCCURRED, {
              id: ct.id,
              action: "Cancel pre-entry order on analyst close",
              error: err?.message ?? String(err),
            });
          }
        } else if (tradeRow.state === "ENTERED") {
          try {
            if (tradeRow.exit_order_id) {
              await dhan.cancelForeverOrder(tradeRow.exit_order_id);
            }

            // We possess the stock, fire an immediate Market SELL to liquidate at CMP
            const sellReq: PlaceOrderRequest = {
              dhanClientId: this.cfg.dhan.clientId,
              correlationId: `liq_${ct.id}`.slice(0, 30),
              transactionType: "SELL",
              exchangeSegment: "NSE_EQ",
              productType: "CNC",
              orderType: "MARKET",
              validity: "DAY",
              securityId: tradeRow.security_id,
              quantity: tradeRow.quantity,
            };
            await dhan.placeOrder(sellReq);

            const exitPrice = ct.cmp ?? Number(tradeRow.entry_price);
            await store.pg.query(
              `UPDATE trades SET state = 'CLOSED_BY_ANALYST', exited_at = NOW(), exit_price = $1 WHERE id = $2`,
              [exitPrice, ct.id],
            );

            await TradeHelpers.recordPnl(store, tradeRow, exitPrice);

            await audit.info(LifecycleEvents.SELL_PLACED, {
              id: ct.id,
              message:
                "Analyst officially closed the trade. Liquidated position at Market.",
            });

            await audit.notify(
              `📤 SELL — Analyst Closed Trade\n` +
                `Symbol: ${tradeRow.symbol}\n` +
                `Liquidated @ Market (₹${exitPrice})\n` +
                `Entry was ₹${tradeRow.entry_price}`,
            );
          } catch (err: any) {
            const payload = TradeHelpers.buildErrorPayload(
              String(ct.id),
              "Liquidate closed trade",
              err,
            );
            await audit.critical(LifecycleEvents.ERROR_OCCURRED, payload);
          }
        }
      }
    } catch (err: any) {
      await audit.error(LifecycleEvents.ERROR_OCCURRED, {
        action: "processClosedTrades",
        error: err.message,
      });
    }
  }

  // Phase 6: Reconcile Dhan holdings with local trades table
  // Uses /holdings — holdings show CNC stock ownership across days.
  //
  // Three reconciliation paths:
  //  A. AWAITING_ENTRY + holding exists → entry happened while server was down
  //     → update to ENTERED, use avgCostPrice, place OCO exit (2nd leg)
  //  B. ENTERED + no holding → exit happened outside our knowledge
  //     → mark CLOSED
  //  C. AWAITING_ENTRY + no holding + forever order not PENDING
  //     → entry was rejected/expired while server was down → mark CANCELLED
  async reconcilePositions(
    store: StateStore,
    dhan: DhanService,
    audit: AuditLogService,
  ): Promise<void> {
    try {
      const holdings = await dhan.getHoldings();
      if (!Array.isArray(holdings)) return;

      const foreverOrders = await dhan.getForeverOrders();
      const regularOrders = await dhan.getOrders();

      // ── Path A: AWAITING_ENTRY trades that already have holdings ──
      // This catches entries that happened while the server was down.
      // forever/orders only shows TRIGGERED for one day, so if we missed it,
      // the only evidence is the holding itself.
      const awaitingRes = await store.pg.query(
        `SELECT * FROM trades WHERE state = 'AWAITING_ENTRY' AND buy_order_id IS NOT NULL`,
      );

      for (const tradeRow of awaitingRes.rows) {
        const holding = holdings.find(
          (h) => String(h.securityId) === String(tradeRow.security_id),
        );

        if (holding && holding.totalQty > 0) {
          // Holding exists! Entry happened while we were down.
          // Use avgCostPrice as entry price (best available data).
          const entryPrice =
            holding.avgCostPrice > 0
              ? holding.avgCostPrice
              : Number(tradeRow.entry_price);

          const qty = Math.min(tradeRow.quantity, holding.totalQty);
          const targetPrice = Number(tradeRow.target) || entryPrice * 1.05;
          const stopLossPrice =
            Number(tradeRow.sl_trigger) || entryPrice * 0.95;

          await TradeHelpers.placeOcoExitAndEnter(this.cfg, {
            store,
            dhan,
            audit,
            tradeRow,
            entryPrice,
            quantity: qty,
            source: "reconcilePositions — Path A (holdings recovery)",
          });
        } else {
          // ── Path C: AWAITING_ENTRY + no holding ──
          // Could be: (1) entry rejected/expired, or (2) entry TRADED but OCO
          // placement failed and holding not yet visible (T+1 settlement).
          // Must check /orders for a TRADED child order before cancelling.
          const foreverOrder = Array.isArray(foreverOrders)
            ? TradeHelpers.findForeverOrder(foreverOrders, tradeRow.buy_order_id)
            : undefined;

          // Check /orders for a TRADED child order linked to this forever order
          const tradedChild = regularOrders.find(
            (o) =>
              String(o.algoId) === String(tradeRow.buy_order_id) &&
              o.orderStatus === "TRADED",
          );

          if (tradedChild) {
            // Entry DID succeed! The child order is TRADED.
            // OCO placement must have failed previously. Retry it now.
            const entryPrice = TradeHelpers.resolveChildPrice(
              tradedChild,
              Number(tradeRow.entry_price),
            );
            const qty = tradedChild.filledQty || tradeRow.quantity;

            await TradeHelpers.placeOcoExitAndEnter(this.cfg, {
              store,
              dhan,
              audit,
              tradeRow,
              entryPrice,
              quantity: qty,
              source: "reconcilePositions — Path C (child order recovery)",
            });
          } else if (
            !foreverOrder ||
            foreverOrder.orderStatus !== "PENDING"
          ) {
            // No TRADED child order, no holding, forever order gone/not pending
            // → entry was truly rejected/expired/cancelled
            await store.pg.query(
              `UPDATE trades SET state = 'CANCELLED' WHERE id = $1`,
              [tradeRow.id],
            );

            await audit.warn(LifecycleEvents.ERROR_OCCURRED, {
              id: tradeRow.id,
              action: "reconcilePositions",
              message:
                "Stale AWAITING_ENTRY: no holding, no traded child order, forever order gone/not pending. Marked CANCELLED.",
              symbol: tradeRow.symbol,
              foreverOrderFound: !!foreverOrder,
              foreverStatus: foreverOrder?.orderStatus ?? "NOT_FOUND",
            });

            await audit.notify(
              `⛔ Stale Entry Cancelled\n` +
                `Symbol: ${tradeRow.symbol}\n` +
                `No holding, no traded order, forever order ${foreverOrder ? foreverOrder.orderStatus : "not found"}.\n` +
                `Likely rejected/expired while server was down.`,
            );
          }
          // else: forever order still PENDING, no holding yet → still waiting for trigger
        }
      }

      // ── Path B: ENTERED trades with no holding ──
      // Exit happened outside our knowledge (manual sell, Dhan app, etc.)
      const enteredRes = await store.pg.query(
        `SELECT * FROM trades WHERE state = 'ENTERED'`,
      );

      for (const tradeRow of enteredRes.rows) {
        const holding = holdings.find(
          (h) => String(h.securityId) === String(tradeRow.security_id),
        );

        if (!holding || holding.totalQty === 0) {
          // Skip trades entered today — CNC holdings only appear after T+1 settlement.
          // Without this guard, a same-day entry (Phase 3) would be falsely closed here.
          if (tradeRow.entered_at) {
            const enteredDate = new Date(tradeRow.entered_at).toDateString();
            const today = new Date().toDateString();
            if (enteredDate === today) continue;
          }

          await store.pg.query(
            `UPDATE trades SET state = 'CLOSED', exited_at = NOW() WHERE id = $1`,
            [tradeRow.id],
          );

          await audit.warn(LifecycleEvents.ERROR_OCCURRED, {
            id: tradeRow.id,
            action: "reconcilePositions",
            message:
              "Trade was ENTERED locally but no holding found on Dhan. Marked CLOSED.",
            symbol: tradeRow.symbol,
          });

          await audit.notify(
            `⚠️ Position Reconciled\n` +
              `Symbol: ${tradeRow.symbol}\n` +
              `Was ENTERED locally but no Dhan holding found.\n` +
              `Marked CLOSED (likely manual exit from Dhan app).`,
          );
        }
      }
    } catch (err: any) {
      await audit.error(LifecycleEvents.ERROR_OCCURRED, {
        action: "reconcilePositions",
        error: err?.message ?? String(err),
      });
    }
  }
}
