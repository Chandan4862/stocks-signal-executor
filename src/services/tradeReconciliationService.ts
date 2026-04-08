/*
  TradeReconciliationService: Handle external closures and reconcile
  Dhan holdings with local trade state.

  processClosedTrades:
  When an analyst closes a trade on the external platform, cancel pending
  orders and liquidate positions. Matches by reco_id (fallback: symbol).

  reconcilePositions:
  Four reconciliation paths:
   A. AWAITING_ENTRY + holding exists → entry happened while server was down
   B. ENTERED + no holding → exit happened outside our knowledge
   C. AWAITING_ENTRY + no holding + forever order not PENDING
      → entry was rejected/expired while server was down
   D. ENTERED + holding + sell_order_id set → stale sell attempt, notify user
*/

import type { AppConfig } from "../config/schema";
import { DhanService } from "./dhanService";
import { StateStore } from "./stateStore";
import { AuditLogService } from "./auditLogService";
import { LifecycleEvents, TradeState } from "../enums/trade";
import { TradeHelpers } from "./tradeHelpers";
import type { ClosedTrade } from "../models/closedTrade";

export class TradeReconciliationService {
  constructor(private cfg: AppConfig) {}

  // ─── processClosedTrades ──────────────────────────────────────────
  // Matches closed trades by reco_id (S4: fallback by symbol).
  // AWAITING_ENTRY → cancel Forever BUY, mark CLOSED.
  // ENTERED → atomic sell guard → Market SELL → CLOSED_BY_ANALYST.
  async processClosedTrades(
    store: StateStore,
    dhan: DhanService,
    audit: AuditLogService,
    closedTrades: ClosedTrade[],
  ): Promise<void> {
    try {
      for (const ct of closedTrades) {
        // Match by reco_id first, then fallback to symbol
        const tradeRow = await this.findLocalTrade(store, ct);
        if (!tradeRow) continue;

        // Already closed locally — skip
        if (
          tradeRow.state === TradeState.CLOSED ||
          tradeRow.state === TradeState.CLOSED_BY_ANALYST
        )
          continue;

        if (tradeRow.state === TradeState.AWAITING_ENTRY) {
          await this.handleClosedAwaitingEntry(
            store,
            dhan,
            audit,
            tradeRow,
            ct,
          );
        } else if (tradeRow.state === TradeState.ENTERED) {
          await this.handleClosedEntered(store, dhan, audit, tradeRow, ct);
        }
      }
    } catch (err: any) {
      await audit.error(LifecycleEvents.ERROR_OCCURRED, {
        action: "processClosedTrades",
        error: err.message,
      });
    }
  }

  // ─── reconcilePositions ───────────────────────────────────────────
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

      // ── Path A: AWAITING_ENTRY + holding exists ──
      const awaitingRes = await store.pg.query(
        `SELECT * FROM trades WHERE state = '${TradeState.AWAITING_ENTRY}' AND buy_order_id IS NOT NULL`,
      );

      for (const tradeRow of awaitingRes.rows) {
        const holding = holdings.find(
          (h) => String(h.securityId) === String(tradeRow.security_id),
        );

        if (holding && holding.totalQty > 0) {
          // Holding exists — entry happened while we were down
          const entryPrice =
            holding.avgCostPrice > 0
              ? holding.avgCostPrice
              : Number(tradeRow.entry_price);
          const qty = Math.min(tradeRow.quantity, holding.totalQty);

          await TradeHelpers.markEntered(
            store,
            audit,
            tradeRow,
            entryPrice,
            qty,
            "reconcilePositions — Path A (holdings recovery)",
          );
        } else {
          // ── Path C: AWAITING_ENTRY + no holding ──
          const foreverOrder = Array.isArray(foreverOrders)
            ? TradeHelpers.findForeverOrder(
                foreverOrders,
                tradeRow.buy_order_id,
              )
            : undefined;

          // Check /orders for any child order spawned by this forever order
          const childOrder = regularOrders.find(
            (o) => String(o.algoId) === String(tradeRow.buy_order_id),
          );

          if (childOrder && childOrder.orderStatus === "TRADED") {
            // Entry DID succeed via child order
            const entryPrice = TradeHelpers.resolveChildPrice(
              childOrder,
              Number(tradeRow.entry_price),
            );
            const qty = childOrder.filledQty || tradeRow.quantity;

            await TradeHelpers.markEntered(
              store,
              audit,
              tradeRow,
              entryPrice,
              qty,
              "reconcilePositions — Path C (child order recovery)",
            );
          } else if (
            childOrder &&
            ["REJECTED", "CANCELLED", "EXPIRED"].includes(
              childOrder.orderStatus,
            )
          ) {
            // Child order exists but failed — cancel with the actual reason
            const reason =
              childOrder.omsErrorDescription ||
              `Child order ${childOrder.orderStatus}`;

            await store.pg.query(
              `UPDATE trades SET state = '${TradeState.CANCELLED}' WHERE id = $1`,
              [tradeRow.id],
            );

            await audit.warn(LifecycleEvents.ERROR_OCCURRED, {
              id: tradeRow.id,
              action: "reconcilePositions — Path C",
              message: `Entry child order ${childOrder.orderStatus}. Marked CANCELLED.`,
              symbol: tradeRow.symbol,
              childOrderId: childOrder.orderId,
              childStatus: childOrder.orderStatus,
              reason,
            });

            await audit.notify(
              `⛔ Entry ${childOrder.orderStatus}\n` +
                `Symbol: ${tradeRow.symbol}\n` +
                `Reason: ${reason}\n` +
                `Order was ${childOrder.orderStatus}`,
            );
          } else if (!foreverOrder || foreverOrder.orderStatus !== "PENDING") {
            // No holding, no usable child, forever order gone/not pending
            const childInfo = childOrder
              ? `child order ${childOrder.orderStatus}`
              : "no child order found";

            await store.pg.query(
              `UPDATE trades SET state = '${TradeState.CANCELLED}' WHERE id = $1`,
              [tradeRow.id],
            );

            await audit.warn(LifecycleEvents.ERROR_OCCURRED, {
              id: tradeRow.id,
              action: "reconcilePositions — Path C",
              message: `Stale AWAITING_ENTRY: no holding, ${childInfo}, forever order gone/not pending. Marked CANCELLED.`,
              symbol: tradeRow.symbol,
              foreverOrderFound: !!foreverOrder,
              foreverStatus: foreverOrder?.orderStatus ?? "NOT_FOUND",
              childOrderStatus: childOrder?.orderStatus ?? "NOT_FOUND",
            });

            await audit.notify(
              `⛔ Stale Entry Cancelled\n` +
                `Symbol: ${tradeRow.symbol}\n` +
                `No holding, ${childInfo}, forever order ${foreverOrder ? foreverOrder.orderStatus : "not found"}.\n` +
                `Likely rejected/expired while server was down.`,
            );
          }
          // else: forever order still PENDING → still waiting for trigger
        }
      }

      // ── Path B: ENTERED + no holding → CLOSED ──
      const enteredRes = await store.pg.query(
        `SELECT * FROM trades WHERE state = '${TradeState.ENTERED}'`,
      );

      for (const tradeRow of enteredRes.rows) {
        // Skip same-day entries (T+1 settlement)
        if (tradeRow.entered_at) {
          const enteredDate = new Date(tradeRow.entered_at).toDateString();
          const today = new Date().toDateString();
          if (enteredDate === today) continue;
        }

        const holding = holdings.find(
          (h) => String(h.securityId) === String(tradeRow.security_id),
        );

        if (!holding || holding.totalQty === 0) {
          // Path B: No holding — just close
          await store.pg.query(
            `UPDATE trades SET state = '${TradeState.CLOSED}', exited_at = NOW() WHERE id = $1`,
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
        } else if (tradeRow.sell_order_id) {
          // Path D: Holding exists but sell_order_id is set (stale sell attempt)
          // Clear sell_order_id to allow retry, then notify user
          await store.pg.query(
            `UPDATE trades SET sell_order_id = NULL WHERE id = $1`,
            [tradeRow.id],
          );

          await audit.warn(LifecycleEvents.ERROR_OCCURRED, {
            id: tradeRow.id,
            action: "reconcilePositions — Path D",
            message:
              "ENTERED trade had stale sell_order_id. Cleared to allow retry. Notified user.",
            symbol: tradeRow.symbol,
            sellOrderId: tradeRow.sell_order_id,
          });

          await audit.notify(
            `🚨 Stale Sell Cleared\n` +
              `Symbol: ${tradeRow.symbol}\n` +
              `Qty: ${tradeRow.quantity}\n` +
              `Previous sell attempt (${tradeRow.sell_order_id}) failed but holding still present.\n` +
              `sell_order_id cleared — will retry on next monitor tick.\n` +
              `If urgent, please exit manually from Dhan app.`,
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

  // ─── Private Helpers ──────────────────────────────────────────────

  /**
   * S4: Find local trade matching a closed trade.
   * Primary: match by reco_id. Fallback: match by symbol + active state.
   */
  private async findLocalTrade(
    store: StateStore,
    ct: ClosedTrade,
  ): Promise<any | null> {
    // Primary: match by reco_id
    const byReco = await store.pg.query(
      `SELECT * FROM trades WHERE reco_id = $1`,
      [ct.id],
    );
    if (byReco.rows.length > 0) return byReco.rows[0];

    // Fallback: match by symbol + active state
    const symbol = String(ct.sc_symbol).toUpperCase();
    if (!symbol) return null;

    const bySymbol = await store.pg.query(
      `SELECT * FROM trades WHERE symbol = $1 AND state IN ('${TradeState.AWAITING_ENTRY}', '${TradeState.ENTERED}') LIMIT 1`,
      [symbol],
    );
    return bySymbol.rows.length > 0 ? bySymbol.rows[0] : null;
  }

  /**
   * Handle analyst closing a trade that is still AWAITING_ENTRY.
   * Cancel the pending Forever BUY order and mark CLOSED.
   */
  private async handleClosedAwaitingEntry(
    store: StateStore,
    dhan: DhanService,
    audit: AuditLogService,
    tradeRow: any,
    ct: ClosedTrade,
  ): Promise<void> {
    try {
      if (tradeRow.buy_order_id) {
        // Best-effort cancel — trade is still marked CLOSED even if this fails
        try {
          await dhan.cancelForeverOrder(tradeRow.buy_order_id);
        } catch (cancelErr: any) {
          await audit.warn(LifecycleEvents.ERROR_OCCURRED, {
            id: tradeRow.id,
            action: "Cancel Forever BUY (best-effort)",
            error: cancelErr?.message ?? String(cancelErr),
          });
        }
      }
      await store.pg.query(
        `UPDATE trades SET state = '${TradeState.CLOSED}' WHERE id = $1`,
        [tradeRow.id],
      );
      await audit.info(LifecycleEvents.SKIP_TRADE, {
        id: tradeRow.id,
        recoId: ct.id,
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
        id: tradeRow.id,
        action: "Cancel pre-entry order on analyst close",
        error: err?.message ?? String(err),
      });
    }
  }

  /**
   * Handle analyst closing a trade that is ENTERED.
   * Place Market SELL via placeSellAndClose() with atomic guard.
   */
  private async handleClosedEntered(
    store: StateStore,
    dhan: DhanService,
    audit: AuditLogService,
    tradeRow: any,
    ct: ClosedTrade,
  ): Promise<void> {
    try {
      const exitPrice = ct.exit_price ?? ct.cmp ?? Number(tradeRow.entry_price);

      await TradeHelpers.placeSellAndClose(this.cfg, {
        store,
        dhan,
        audit,
        tradeRow,
        exitPrice,
        source: "processClosedTrades — analyst closed",
        closedState: TradeState.CLOSED_BY_ANALYST,
      });
    } catch (err: any) {
      const payload = TradeHelpers.buildErrorPayload(
        String(tradeRow.id),
        "Liquidate closed trade",
        err,
      );
      await audit.critical(LifecycleEvents.ERROR_OCCURRED, payload);
    }
  }
}
