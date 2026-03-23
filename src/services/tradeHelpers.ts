/*
  TradeHelpers: Shared utilities for trade lifecycle services.
  Encapsulates OCO exit placement, price resolution, error payload
  construction, and PnL recording.
*/

import type { AppConfig } from "../config/schema";
import {
  DhanService,
  DhanApiError,
  PlaceForeverOrderRequest,
} from "./dhanService";
import { StateStore } from "./stateStore";
import { AuditLogService } from "./auditLogService";
import { LifecycleEvents } from "../enums/trade";

/**
 * Options for placing an OCO exit order and transitioning a trade to ENTERED.
 */
export interface OcoExitOptions {
  store: StateStore;
  dhan: DhanService;
  audit: AuditLogService;
  tradeRow: any;
  entryPrice: number;
  quantity: number;
  source: string; // e.g. "monitorPendingEntries", "reconcilePositions — Path A"
}

/**
 * Shared helper functions used across trade lifecycle services.
 * Static-only class — no instance needed.
 */
export class TradeHelpers {
  /**
   * Place OCO exit order and update trade to ENTERED state.
   * Single Responsibility: encapsulates OCO request building, placement, DB update,
   * audit logging, and Telegram notification.
   *
   * @returns true if OCO was successfully placed, false otherwise.
   */
  static async placeOcoExitAndEnter(
    cfg: AppConfig,
    opts: OcoExitOptions,
  ): Promise<boolean> {
    const { store, dhan, audit, tradeRow, entryPrice, quantity, source } = opts;

    const targetPrice = Number(tradeRow.target) || entryPrice * 1.05;
    const stopLossPrice = Number(tradeRow.sl_trigger) || entryPrice * 0.95;

    const exitReq: PlaceForeverOrderRequest = {
      dhanClientId: cfg.dhan.clientId,
      correlationId: `exit_${tradeRow.id}`.slice(0, 30),
      orderFlag: "OCO",
      transactionType: "SELL",
      exchangeSegment: "NSE_EQ",
      productType: "CNC",
      orderType: "LIMIT",
      validity: "DAY",
      securityId: tradeRow.security_id,
      quantity,
      // Leg 1: Target
      price: targetPrice,
      triggerPrice: targetPrice,
      // Leg 2: Stop Loss
      price1: stopLossPrice,
      triggerPrice1: stopLossPrice,
      quantity1: quantity,
    };

    try {
      const exitRes = await dhan.placeForeverOrder(exitReq);

      await store.pg.query(
        `UPDATE trades
         SET state = 'ENTERED',
             entered_at = NOW(),
             entry_price = $1,
             exit_order_id = $2,
             quantity = $3
         WHERE id = $4`,
        [entryPrice, exitRes.orderId, quantity, tradeRow.id],
      );

      await audit.info(LifecycleEvents.BUY_PLACED, {
        id: tradeRow.id,
        source,
        message: "Placed OCO Exit. Trade is now ENTERED.",
        entryPrice,
        exitOrderId: exitRes.orderId,
      });

      await audit.notify(
        `✅ ENTRY Confirmed — OCO Exit Placed\n` +
          `Symbol: ${tradeRow.symbol}\n` +
          `Entered @ ₹${entryPrice} | Qty: ${quantity}\n` +
          `OCO Exit: ${exitRes.orderId}\n` +
          `Target: ₹${targetPrice} | SL: ₹${stopLossPrice}\n` +
          `Source: ${source}`,
      );

      return true;
    } catch (err: any) {
      const payload = TradeHelpers.buildErrorPayload(
        tradeRow.id,
        `${source} — OCO placement failed`,
        err,
      );
      await audit.critical(LifecycleEvents.ERROR_OCCURRED, payload);
      return false;
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
  static buildErrorPayload(
    id: string,
    action: string,
    err: any,
  ): Record<string, any> {
    if (err instanceof DhanApiError) {
      return { id, action, ...err.toAuditPayload() };
    }
    return { id, action, error: err?.message ?? String(err) };
  }

  /**
   * Record realized PnL into pnl_records table.
   */
  static async recordPnl(
    store: StateStore,
    tradeRow: any,
    exitPrice: number,
  ): Promise<void> {
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
