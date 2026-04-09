/*
  TradeHelpers: Shared utilities for trade lifecycle services.
  Encapsulates entry confirmation, sell placement, price resolution,
  error payload construction, and PnL recording.
*/

import type { AppConfig } from "../config/schema";
import { DhanService, DhanApiError, PlaceOrderRequest } from "./dhanService";
import { StateStore } from "./stateStore";
import { AuditLogService } from "./auditLogService";
import { LifecycleEvents, TradeState } from "../enums/trade";

/**
 * Options for placing a sell order and closing a trade.
 */
export interface SellAndCloseOptions {
  store: StateStore;
  dhan: DhanService;
  audit: AuditLogService;
  tradeRow: any;
  exitPrice: number; // price to record (may differ from actual fill)
  source: string; // e.g. "monitorEnteredTrades", "processClosedTrades"
  closedState?: string; // "CLOSED" | "CLOSED_BY_ANALYST" — defaults to "CLOSED"
}

/**
 * Shared helper functions used across trade lifecycle services.
 * Static-only class — no instance needed.
 */
export class TradeHelpers {
  /**
   * Mark a trade as ENTERED — update state, entry price, quantity.
   * Does NOT place any exit order.
   * Guards on state = AWAITING_ENTRY to prevent overwriting CLOSED/ENTERED.
   * @returns true if state was updated, false if trade was no longer AWAITING_ENTRY.
   */
  static async markEntered(
    store: StateStore,
    audit: AuditLogService,
    tradeRow: any,
    entryPrice: number,
    quantity: number,
    source: string,
  ): Promise<boolean> {
    const res = await store.pg.query(
      `UPDATE trades
       SET state = '${TradeState.ENTERED}',
           entered_at = NOW(),
           entry_price = $1,
           quantity = $2
       WHERE id = $3 AND state = '${TradeState.AWAITING_ENTRY}'
       RETURNING id`,
      [entryPrice, quantity, tradeRow.id],
    );

    if (res.rows.length === 0) {
      // Trade was no longer AWAITING_ENTRY — state changed concurrently
      return false;
    }

    await audit.info(LifecycleEvents.BUY_PLACED, {
      id: tradeRow.id,
      source,
      message: "Entry confirmed. Trade is now ENTERED.",
      entryPrice,
      quantity,
    });

    await audit.notify(
      `✅ ENTRY Confirmed\n` +
        `Symbol: ${tradeRow.symbol}\n` +
        `Entered @ ₹${entryPrice} | Qty: ${quantity}\n` +
        `Source: ${source}`,
    );

    return true;
  }

  /**
   * Determine if a position should be sold based on last traded price.
   * Returns 'TARGET' if price >= target, 'STOPLOSS' if price <= sl, null otherwise.
   */
  static shouldSell(
    lastTradedPrice: number,
    target: number | null | undefined,
    sl: number | null | undefined,
  ): "TARGET" | "STOPLOSS" | null {
    if (target && lastTradedPrice >= target) return "TARGET";
    if (sl && lastTradedPrice <= sl) return "STOPLOSS";
    return null;
  }

  /**
   * Place a Market SELL order with atomic sell guard and close the trade.
   *
   * Flow:
   *  1. Atomic guard: SET sell_order_id WHERE sell_order_id IS NULL (S1)
   *  2. Place Market SELL via dhan.placeOrder()
   *  3. Record PnL
   *  4. Update state to CLOSED / CLOSED_BY_ANALYST
   *
   * On sell failure: clears sell_order_id, logs error, notifies user.
   *
   * @returns { success: true, orderId } or { success: false, error }
   */
  static async placeSellAndClose(
    cfg: AppConfig,
    opts: SellAndCloseOptions,
  ): Promise<{ success: boolean; orderId?: string; error?: string }> {
    const { store, dhan, audit, tradeRow, exitPrice, source } = opts;
    const closedState = opts.closedState ?? TradeState.CLOSED;

    // S1: Atomic sell guard — prevent duplicate sells
    const pendingId = `pending_${tradeRow.id}`;
    const guardRes = await store.pg.query(
      `UPDATE trades SET sell_order_id = $1 WHERE id = $2 AND sell_order_id IS NULL RETURNING id`,
      [pendingId, tradeRow.id],
    );

    if (guardRes.rows.length === 0) {
      // sell_order_id already set — another sell was already attempted
      return { success: false, error: "Sell already in progress or completed" };
    }

    try {
      // Place Market SELL
      const sellReq: PlaceOrderRequest = {
        dhanClientId: cfg.dhan.clientId,
        correlationId: `sell_${tradeRow.id}`.slice(0, 30),
        transactionType: "SELL",
        exchangeSegment: "NSE_EQ",
        productType: "CNC",
        orderType: "MARKET",
        validity: "DAY",
        securityId: tradeRow.security_id,
        quantity: tradeRow.quantity,
      };
      // If this fails → catch block clears sell_order_id, trade stays ENTERED, retries next tick
      const sellRes = await dhan.placeOrder(sellReq);

      // Update sell_order_id with actual orderId
      await store.pg.query(`UPDATE trades SET sell_order_id = $1 WHERE id = $2`, [
        sellRes.orderId,
        tradeRow.id,
      ]);

      // Record PnL
      await TradeHelpers.recordPnl(store, tradeRow, exitPrice);

      // Mark trade closed
      await store.pg.query(
        `UPDATE trades SET state = $1, exited_at = NOW(), exit_price = $2 WHERE id = $3`,
        [closedState, exitPrice, tradeRow.id],
      );

      const entryPrice = Number(tradeRow.entry_price);
      const pnl = (exitPrice - entryPrice) * tradeRow.quantity;
      const pnlSign = pnl >= 0 ? "+" : "";
      const emoji = pnl >= 0 ? "🟢" : "🔴";

      await audit.info(LifecycleEvents.SELL_PLACED, {
        id: tradeRow.id,
        source,
        message: `Sell placed. Trade ${closedState}.`,
        exitPrice,
        orderId: sellRes.orderId,
        pnl,
      });

      await audit.notify(
        `${emoji} SELL — Position Closed\n` +
          `Symbol: ${tradeRow.symbol}\n` +
          `Entry: ₹${entryPrice} → Exit: ₹${exitPrice}\n` +
          `Qty: ${tradeRow.quantity} | PnL: ${pnlSign}₹${pnl.toFixed(2)}\n` +
          `Source: ${source}`,
      );

      return { success: true, orderId: sellRes.orderId };
    } catch (err: any) {
      // Sell failed — clear sell_order_id so next tick can retry
      await store.pg.query(`UPDATE trades SET sell_order_id = NULL WHERE id = $1`, [tradeRow.id]);

      const payload = TradeHelpers.buildErrorPayload(
        String(tradeRow.id),
        `${source} — SELL failed`,
        err,
      );
      await audit.critical(LifecycleEvents.ERROR_OCCURRED, payload);

      await audit.notify(
        `🚨 SELL FAILED\n` +
          `Symbol: ${tradeRow.symbol}\n` +
          `Qty: ${tradeRow.quantity}\n` +
          `Error: ${err?.message ?? String(err)}\n` +
          `Will retry on next tick. Manual exit may be needed.`,
      );

      return { success: false, error: err?.message ?? String(err) };
    }
  }

  /**
   * Resolve the traded price from a Dhan child order.
   * Prefers averageTradedPrice → price → fallback.
   */
  static resolveChildPrice(childOrder: any, fallbackPrice: number): number {
    if (childOrder.averageTradedPrice > 0) return childOrder.averageTradedPrice;
    if (childOrder.price > 0) return childOrder.price;
    return fallbackPrice;
  }

  /**
   * Build an error payload from either a DhanApiError or a generic Error.
   * Eliminates repeated instanceof checks across the codebase.
   */
  static buildErrorPayload(id: string, action: string, err: any): Record<string, any> {
    if (err instanceof DhanApiError) {
      return { id, action, ...err.toAuditPayload() };
    }
    return { id, action, error: err?.message ?? String(err) };
  }

  /**
   * Record realized PnL into pnl_records table.
   */
  static async recordPnl(store: StateStore, tradeRow: any, exitPrice: number): Promise<void> {
    try {
      const entryPrice = Number(tradeRow.entry_price);
      const quantity = Number(tradeRow.quantity);
      const pnl = (exitPrice - entryPrice) * quantity;

      await store.pg.query(
        `INSERT INTO pnl_records (trade_id, tradingsymbol, quantity, entry_price, exit_price, realized_pnl, exited_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [
          tradeRow.id,
          tradeRow.tradingsymbol || tradeRow.symbol,
          quantity,
          entryPrice,
          exitPrice,
          pnl,
        ],
      );
    } catch (err: any) {
      // PnL recording failure should not break trade flow
      console.error("recordPnl failed:", err?.message);
    }
  }

  /**
   * Find a forever order by orderId in the array.
   */
  static findForeverOrder(orders: any[], orderId: string): any | undefined {
    return orders.find((o) => String(o.orderId) === String(orderId));
  }

  /**
   * Find a child order by algoId in the regular orders array.
   */
  static findChildOrder(orders: any[], algoId: string): any | undefined {
    return orders.find((o) => String(o.algoId) === String(algoId));
  }
}
