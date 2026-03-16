/*
 TradeSyncService: Polls Active and Closed APIs, reconciles transitions,
 enforces idempotency, and triggers Dhan operations.
 All state is stored in Postgres (no Redis dependency).
*/

import axios from "axios";
import type { AppConfig } from "../config/schema";
import type { ActiveTrade } from "../models/activeTrade";
import type { ClosedTrade } from "../models/closedTrade";
import type { ValidatedTrade } from "../models/validatedTrade";
import { StateStore } from "./stateStore";
import {
  DhanService,
  DhanApiError,
  PlaceOrderRequest,
  PlaceOrderResponse,
  PlaceSuperOrderRequest,
  PlaceForeverOrderRequest,
} from "./dhanService";
import { QuantityResolverService } from "./quantityResolverService";
import { TSLService } from "./tslService";
import { AuditLogService } from "./auditLogService";
import { InstrumentLookupService } from "./instrumentLookupService";
import { InstrumentType, LifecycleEvents } from "../enums/trade";

export class TradeSyncService {
  constructor(private cfg: AppConfig) {}

  async fetchActiveTrades(): Promise<ActiveTrade[]> {
    const { data } = await axios.get(this.cfg.apis.activeTradesUrl);
    const list = Array.isArray(data) ? data : (data?.list?.data ?? []);
    if (Array.isArray(list) && list.length > 0) {
      return (list as any[]).map(this.normalizeActive);
    }
    return list.map(this.normalizeActive);
  }

  async fetchClosedTrades(): Promise<ClosedTrade[]> {
    const { data } = await axios.get(this.cfg.apis.closedTradesUrl);
    return (data as any[]).map(this.normalizeClosed);
  }

  // Phase 2: Run BUY + initial SL placement for newly discovered active trades
  async runBuyAndInitialSl(
    store: StateStore,
    dhan: DhanService,
    qtyResolver: QuantityResolverService,
    tslService: TSLService,
    audit: AuditLogService,
    instrumentLookup: InstrumentLookupService,
  ): Promise<void> {
    const actives = await this.fetchActiveTrades();

    for (const at of actives) {
      // Only process cash instruments
      if (!(await this.isCashInstrument(at, audit))) continue;

      const id = at.id;

      try {
        // Idempotency guard (Postgres-backed)
        const idempRes = await store.pg.query(
          `SELECT 1 FROM idempotency WHERE action_key = $1`,
          [`buy:${id}`],
        );
        if (idempRes.rows.length > 0) continue;

        // Validate & resolve trade params (includes trade count + capital guards)
        const validated = await this.validateAndResolveTrade(
          at,
          store,
          qtyResolver,
          tslService,
          audit,
          instrumentLookup,
        );
        if (!validated) continue;

        // Place order
        const buyRes = await this.placeForeverEntry(dhan, validated);

        // Persist state (idempotency, trade record, audit)
        await this.persistBuyState(store, audit, validated, buyRes, at);
      } catch (err: any) {
        const payload =
          err instanceof DhanApiError
            ? { id: at.id, ...err.toAuditPayload() }
            : { id: at.id, error: String(err?.message || err) };
        await audit.critical(LifecycleEvents.ERROR_OCCURRED, payload);
      }
    }
  }

  // Phase 3: Monitor pending Forever Orders and attach OCO Exit legs
  // ┌─────────────────────────────────────────────────────────────┐
  // │  monitorPendingEntries (runs on polling interval)           │
  // │                                                             │
  // │  1. GET /v2/forever/all  →  fetch all Dhan Forever Orders   │
  // │  2. SELECT trades WHERE state = 'AWAITING_ENTRY'            │
  // │  3. For each pending trade:                                 │
  // │     └─ Match buy_order_id with Dhan orderId                 │
  // │        ├─ TRADED     →  place OCO exit, update to ENTERED   │
  // │        ├─ CANCELLED  →  mark CLOSED                         │
  // │        ├─ REJECTED   →  mark CLOSED                         │
  // │        ├─ EXPIRED    →  mark CLOSED                         │
  // │        └─ PENDING    →  do nothing (check again next poll)  │
  // └─────────────────────────────────────────────────────────────┘
  async monitorPendingEntries(
    store: StateStore,
    dhan: DhanService,
    audit: AuditLogService,
  ): Promise<void> {
    try {
      // 1. Fetch all Forever Orders from Dhan
      const foreverOrders = await dhan.getForeverOrders();
      if (!Array.isArray(foreverOrders)) return;

      // 2. Query Postgres for trades in AWAITING_ENTRY state
      const pendingRes = await store.pg.query(
        `SELECT * FROM trades WHERE state = 'AWAITING_ENTRY' AND buy_order_id IS NOT NULL`,
      );

      for (const tradeRow of pendingRes.rows) {
        // 3. Find the corresponding Dhan order
        const dhanOrder = foreverOrders.find(
          (o) => String(o.orderId) === String(tradeRow.buy_order_id),
        );

        if (!dhanOrder) continue;

        // 4. If the order is TRADED (meaning entry breakout/dip was hit)
        if (dhanOrder.orderStatus === "TRADED") {
          // We have entered the position! Let's place the OCO Exit Bracket.
          const tradedPrice =
            typeof dhanOrder.price === "number"
              ? dhanOrder.price
              : Number(tradeRow.entry_price);

          const targetPrice = Number(tradeRow.target) || tradedPrice * 1.05;
          const stopLossPrice =
            Number(tradeRow.sl_trigger) || tradedPrice * 0.95;

          const exitReq: PlaceForeverOrderRequest = {
            dhanClientId: this.cfg.dhan.clientId,
            correlationId: `exit_${tradeRow.id}`.slice(0, 30),
            orderFlag: "OCO",
            transactionType: "SELL",
            exchangeSegment: "NSE_EQ",
            productType: "CNC",
            orderType: "LIMIT",
            validity: "DAY",
            securityId: tradeRow.security_id,
            quantity: tradeRow.quantity,
            // Leg 1: Target
            price: targetPrice,
            triggerPrice: targetPrice,
            // Leg 2: Stop Loss
            price1: stopLossPrice,
            triggerPrice1: stopLossPrice,
            quantity1: tradeRow.quantity,
          };

          try {
            const exitRes = await dhan.placeForeverOrder(exitReq);

            // Update trade to ENTERED in Postgres
            await store.pg.query(
              `UPDATE trades
               SET state = 'ENTERED',
                   entered_at = NOW(),
                   entry_price = $1,
                   exit_order_id = $2
               WHERE id = $3`,
              [tradedPrice, exitRes.orderId, tradeRow.id],
            );

            await audit.info(LifecycleEvents.BUY_PLACED, {
              id: tradeRow.id,
              message: "Entry Forever Order TRADED. Attached OCO Exit.",
              entryPrice: tradedPrice,
              exitOrderId: exitRes.orderId,
            });

            await audit.notify(
              `✅ ENTRY Triggered\n` +
                `Symbol: ${tradeRow.symbol}\n` +
                `Entered @ ₹${tradedPrice} | Qty: ${tradeRow.quantity}\n` +
                `OCO Exit placed: ${exitRes.orderId}\n` +
                `Target: ₹${tradeRow.target} | SL: ₹${tradeRow.sl_trigger}`,
            );
          } catch (err: any) {
            const payload =
              err instanceof DhanApiError
                ? {
                    id: tradeRow.id,
                    action: "Attach OCO Exit",
                    ...err.toAuditPayload(),
                  }
                : {
                    id: tradeRow.id,
                    action: "Attach OCO Exception",
                    error: err.message,
                  };
            await audit.critical(LifecycleEvents.ERROR_OCCURRED, payload);
          }
        } else if (
          dhanOrder.orderStatus === "CANCELLED" ||
          dhanOrder.orderStatus === "REJECTED" ||
          dhanOrder.orderStatus === "EXPIRED"
        ) {
          // Entry failed or was cancelled by user directly on Dhan
          await store.pg.query(
            `UPDATE trades SET state = 'CANCELLED' WHERE id = $1`,
            [tradeRow.id],
          );
          await audit.warn(LifecycleEvents.ERROR_OCCURRED, {
            id: tradeRow.id,
            action: "Entry Order Cancelled/Rejected",
            orderStatus: dhanOrder.orderStatus,
          });

          await audit.notify(
            `⛔ Entry Order ${dhanOrder.orderStatus}\n` +
              `Symbol: ${tradeRow.symbol}\n` +
              `Order: ${tradeRow.buy_order_id}`,
          );
        }
      }
    } catch (err: any) {
      await audit.error(LifecycleEvents.ERROR_OCCURRED, {
        action: "monitorPendingEntries",
        error: err.message,
      });
    }
  }

  // Phase 4: Handle External Closures via Closed Trades API
  async processClosedTrades(
    store: StateStore,
    dhan: DhanService,
    audit: AuditLogService,
  ): Promise<void> {
    try {
      const closedTrades = await this.fetchClosedTrades();
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

            await this.recordPnl(store, tradeRow, exitPrice);

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
            const payload =
              err instanceof DhanApiError
                ? {
                    id: ct.id,
                    action: "Liquidate closed trade",
                    ...err.toAuditPayload(),
                  }
                : {
                    id: ct.id,
                    message: "Failed to liquidate closed trade",
                    error: err.message,
                  };
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
  // Phase 5: Monitor ENTERED trades — check if exit orders (OCO) have triggered
  // ┌───────────────────────────────────────────────────────────────────┐
  // │  monitorEnteredTrades (runs on polling interval)                  │
  // │                                                                   │
  // │  1. SELECT trades WHERE state = 'ENTERED'                         │
  // │  2. For each trade with exit_order_id:                            │
  // │     └─ Fetch order status from Dhan                               │
  // │        ├─ TRADED     → mark CLOSED, record PnL, notify 📤        │
  // │        ├─ CANCELLED  → alert 🔴 (position unprotected)           │
  // │        ├─ REJECTED   → alert 🔴                                  │
  // │        ├─ EXPIRED    → alert 🔴                                  │
  // │        └─ PENDING    → do nothing                                 │
  // │  3. Cross-check Dhan positions for manual exits                   │
  // └───────────────────────────────────────────────────────────────────┘
  async monitorEnteredTrades(
    store: StateStore,
    dhan: DhanService,
    audit: AuditLogService,
  ): Promise<void> {
    try {
      // 1. Query all ENTERED trades
      const enteredRes = await store.pg.query(
        `SELECT * FROM trades WHERE state = 'ENTERED' AND exit_order_id IS NOT NULL`,
      );
      if (enteredRes.rows.length === 0) return;

      // 2. Fetch all today's orders from Dhan (batch — avoids N+1 API calls)
      const allOrders = await dhan.getOrders();
      // Also fetch forever orders (OCO exits are forever orders)
      const foreverOrders = await dhan.getForeverOrders();
      const combinedOrders = [...allOrders, ...foreverOrders];

      for (const tradeRow of enteredRes.rows) {
        // Find the exit order in Dhan's order list
        const exitOrder = combinedOrders.find(
          (o) => String(o.orderId) === String(tradeRow.exit_order_id),
        );

        if (!exitOrder) {
          // Exit order not found — might be from a previous day or manually deleted
          // Check if position still exists on Dhan
          continue;
        }

        if (exitOrder.orderStatus === "TRADED") {
          // Exit triggered! SL or Target hit.
          const exitPrice =
            typeof exitOrder.price === "number" && exitOrder.price > 0
              ? exitOrder.price
              : Number(tradeRow.entry_price);

          await store.pg.query(
            `UPDATE trades SET state = 'CLOSED', exited_at = NOW(), exit_price = $1 WHERE id = $2`,
            [exitPrice, tradeRow.id],
          );

          await this.recordPnl(store, tradeRow, exitPrice);

          const entryPrice = Number(tradeRow.entry_price);
          const pnl = (exitPrice - entryPrice) * tradeRow.quantity;
          const pnlSign = pnl >= 0 ? "+" : "";
          const emoji = pnl >= 0 ? "🟢" : "🔴";

          await audit.info(LifecycleEvents.SELL_PLACED, {
            id: tradeRow.id,
            message: "Exit order TRADED. Position closed.",
            exitPrice,
            pnl,
          });

          await audit.notify(
            `${emoji} EXIT Triggered — Position Closed\n` +
              `Symbol: ${tradeRow.symbol}\n` +
              `Entry: ₹${entryPrice} → Exit: ₹${exitPrice}\n` +
              `Qty: ${tradeRow.quantity} | PnL: ${pnlSign}₹${pnl.toFixed(2)}`,
          );
        } else if (
          exitOrder.orderStatus === "CANCELLED" ||
          exitOrder.orderStatus === "REJECTED" ||
          exitOrder.orderStatus === "EXPIRED"
        ) {
          // Exit order failed — position is UNPROTECTED!
          await audit.critical(LifecycleEvents.ERROR_OCCURRED, {
            id: tradeRow.id,
            action: "monitorEnteredTrades",
            error: `Exit order ${exitOrder.orderStatus} — position UNPROTECTED!`,
            exitOrderId: tradeRow.exit_order_id,
            symbol: tradeRow.symbol,
            quantity: tradeRow.quantity,
          });

          await audit.notify(
            `🚨 EXIT ORDER ${exitOrder.orderStatus}\n` +
              `Symbol: ${tradeRow.symbol}\n` +
              `Qty: ${tradeRow.quantity} — Position UNPROTECTED!\n` +
              `Exit Order: ${tradeRow.exit_order_id}\n` +
              `Manual action required.`,
          );
        }
      }
    } catch (err: any) {
      await audit.error(LifecycleEvents.ERROR_OCCURRED, {
        action: "monitorEnteredTrades",
        error: err?.message ?? String(err),
      });
    }
  }

  // Phase 6: Reconcile Dhan positions with local trades table
  // Safety net — catches anything that slipped through the cracks.
  async reconcilePositions(
    store: StateStore,
    dhan: DhanService,
    audit: AuditLogService,
  ): Promise<void> {
    try {
      const positions = await dhan.getPositions();
      if (!Array.isArray(positions)) return;

      // 1. Query all locally ENTERED trades
      const enteredRes = await store.pg.query(
        `SELECT * FROM trades WHERE state = 'ENTERED'`,
      );

      const localSecurityIds = new Set(
        enteredRes.rows.map((r: any) => String(r.security_id)),
      );

      // 2. Check for stale ENTERED trades (locally ENTERED but no position on Dhan)
      // A position with netQty=0 means fully exited
      for (const tradeRow of enteredRes.rows) {
        const pos = positions.find(
          (p) => String(p.securityId) === String(tradeRow.security_id),
        );

        if (!pos || pos.netQty === 0) {
          // Position doesn't exist on Dhan but trade is ENTERED locally
          // → the exit happened outside our knowledge (manual sell, Dhan app, etc.)
          await store.pg.query(
            `UPDATE trades SET state = 'CLOSED', exited_at = NOW() WHERE id = $1`,
            [tradeRow.id],
          );

          await audit.warn(LifecycleEvents.ERROR_OCCURRED, {
            id: tradeRow.id,
            action: "reconcilePositions",
            message:
              "Trade was ENTERED locally but no position found on Dhan. Marked CLOSED.",
            symbol: tradeRow.symbol,
          });

          await audit.notify(
            `⚠️ Position Reconciled\n` +
              `Symbol: ${tradeRow.symbol}\n` +
              `Was ENTERED locally but no Dhan position found.\n` +
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

  /**
   * Record realized PnL into pnl_records table.
   */
  private async recordPnl(
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

  // ─── Extracted Private Methods ──────────────────────────────────────

  /**
   * Guard: returns true if the ActiveTrade is a cash instrument.
   * Logs SKIP_TRADE audit for non-cash.
   */
  private async isCashInstrument(
    at: ActiveTrade,
    audit: AuditLogService,
  ): Promise<boolean> {
    if (at.instrument_type !== InstrumentType.CASH) {
      await audit.debug(LifecycleEvents.SKIP_TRADE, {
        id: at.id,
        reason: "Skipping non-cash instrument",
        instrument_type: at.instrument_type,
      });
      return false;
    }
    return true;
  }

  /**
   * Validate & resolve: securityId, entryPrice, qty, slTrigger, target.
   * Includes max trade count and max capital guards.
   * Returns ValidatedTrade or null to skip.
   */
  private async validateAndResolveTrade(
    at: ActiveTrade,
    store: StateStore,
    qtyResolver: QuantityResolverService,
    tslService: TSLService,
    audit: AuditLogService,
    instrumentLookup: InstrumentLookupService,
  ): Promise<ValidatedTrade | null> {
    const id = at.id;
    const symbol = String(at.sc_symbol || "").toUpperCase();
    const activeStates = ["AWAITING_ENTRY", "ENTERED"];

    // ── Guard 1: Max active trade count ──────────────────────────────
    try {
      const countRes = await store.pg.query(
        `SELECT COUNT(*) AS cnt FROM trades WHERE state = ANY($1)`,
        [activeStates],
      );
      const activeCount = Number(countRes.rows?.[0]?.cnt ?? 0);
      if (activeCount >= this.cfg.maxActiveTrades) {
        await audit.warn(LifecycleEvents.SKIP_TRADE, {
          id,
          reason: "Max active trade limit reached",
          activeCount,
          maxActiveTrades: this.cfg.maxActiveTrades,
        });
        return null;
      }
    } catch (err: any) {
      await audit.error(LifecycleEvents.ERROR_OCCURRED, {
        id,
        action: "Check active trade count",
        error: err.message,
      });
      return null;
    }

    // ── Resolve securityId from instrument_list_nse_eq ────────────────
    if (!symbol) {
      await audit.warn(LifecycleEvents.ERROR_OCCURRED, {
        id,
        reason: "Missing sc_symbol — cannot resolve securityId",
      });
      return null;
    }

    const securityId = await instrumentLookup.resolveSecurityId(symbol);
    if (!securityId) {
      await audit.warn(LifecycleEvents.ERROR_OCCURRED, {
        id,
        reason: "No instrument found in instrument_list_nse_eq",
        symbol,
      });
      return null;
    }

    const cmp = at.cmp ?? 0;

    // ── Resolve entry price ──────────────────────────────────────────
    const entryPrice =
      (typeof at.entry_price === "number" ? at.entry_price : undefined) ?? cmp;
    if (!entryPrice || entryPrice <= 0) {
      audit.record(LifecycleEvents.ERROR_OCCURRED, {
        id,
        reason: "Invalid entry price",
        entryPrice,
      });
      return null;
    }

    const entryPrice2 =
      typeof at.entry_price_2 === "number" ? at.entry_price_2 : undefined;
    const entryCondition = at.entry_condition || "";

    // ── Resolve capital & quantity ───────────────────────────────────
    const perTradeCapital =
      (at as any)?.meta?.max_capital ?? this.cfg.perTradeCapital;
    const qty = qtyResolver.deriveQty(entryPrice, Number(perTradeCapital));
    if (!qty || qty <= 0) {
      audit.record(LifecycleEvents.ERROR_OCCURRED, {
        id,
        reason: "Derived quantity is 0",
        entryPrice,
        capital: perTradeCapital,
      });
      return null;
    }

    // ── Guard 2: Max deployed capital ────────────────────────────────
    const newTradeCapital = entryPrice * qty;
    try {
      const capRes = await store.pg.query(
        `SELECT COALESCE(SUM(entry_price * quantity), 0) AS deployed
         FROM trades WHERE state = ANY($1)`,
        [activeStates],
      );
      const deployedCapital = Number(capRes.rows?.[0]?.deployed ?? 0);
      if (deployedCapital + newTradeCapital > this.cfg.maxTradeCapital) {
        await audit.warn(LifecycleEvents.SKIP_TRADE, {
          id,
          reason: "Max deployed capital would be exceeded",
          deployedCapital,
          newTradeCapital,
          maxTradeCapital: this.cfg.maxTradeCapital,
        });
        return null;
      }
    } catch (err: any) {
      await audit.error(LifecycleEvents.ERROR_OCCURRED, {
        id,
        action: "Check deployed capital",
        error: err.message,
      });
      return null;
    }

    // ── Resolve SL trigger & target ──────────────────────────────────
    const slTrigger =
      typeof at.stoploss_price === "number" && at.stoploss_price > 0
        ? at.stoploss_price
        : tslService.initialStopLoss(entryPrice);
    const target =
      typeof at.target_price_1 === "number" && at.target_price_1 > 0
        ? at.target_price_1
        : undefined;

    return {
      id,
      securityId,
      symbol,
      cmp,
      entryCondition,
      entryPrice,
      entryPrice2,
      quantity: qty,
      capital: perTradeCapital,
      slTrigger,
      target,
    };
  }

  /**
   * Place entry order: SINGLE Forever Order for entry breakout/limit conditions.
   */
  private async placeForeverEntry(
    dhan: DhanService,
    v: ValidatedTrade,
  ): Promise<PlaceOrderResponse> {
    // Default trigger is the entryPrice
    let triggerPrice = v.entryPrice;

    if (v.entryCondition === "between" && v.entryPrice2) {
      if (v.cmp < v.entryPrice) {
        triggerPrice = v.entryPrice; // Breakout buy
      } else if (v.cmp > v.entryPrice2) {
        triggerPrice = v.entryPrice2; // Buy on dip
      } else {
        // We are within range. For safety/consistency, trigger at CMP or slightly below
        triggerPrice = v.cmp;
      }
    } else if (v.entryCondition === "greater_than") {
      triggerPrice = v.entryPrice; // Buy if crosses above
    } else {
      triggerPrice = v.entryPrice; // Default fallback
    }

    // `price` for the actual limit order triggered once `triggerPrice` hits.
    // Adding a 0.5% buffer above trigger to ensure execution during fast breakouts
    const executionLimitPrice = Number((triggerPrice * 1.005).toFixed(1));

    const req: PlaceForeverOrderRequest = {
      dhanClientId: this.cfg.dhan.clientId,
      correlationId: `buy_${v.id}`.slice(0, 30),
      orderFlag: "SINGLE",
      transactionType: "BUY",
      exchangeSegment: "NSE_EQ", // Assumes NSE Equities for now
      productType: "CNC", // Cash and Carry delivery
      orderType: "LIMIT",
      validity: "DAY",
      securityId: v.securityId,
      quantity: v.quantity,
      price: executionLimitPrice,
      triggerPrice: triggerPrice,
    };

    return dhan.placeForeverOrder(req);
  }

  /**
   * Persist BUY state: set idempotency key, insert trade record, record audit.
   * All state in Postgres — no Redis.
   */
  private async persistBuyState(
    store: StateStore,
    audit: AuditLogService,
    v: ValidatedTrade,
    buyRes: PlaceOrderResponse,
    reco?: ActiveTrade,
  ): Promise<void> {
    // Set idempotency guard
    await store.pg.query(
      `INSERT INTO idempotency (action_key) VALUES ($1) ON CONFLICT DO NOTHING`,
      [`buy:${v.id}`],
    );

    // Upsert trade record with all fields
    await store.pg.query(
      `INSERT INTO trades (id, tradingsymbol, exchange, reco_type, entry_price, quantity, state,
                           security_id, symbol, buy_order_id, target, sl_trigger, capital, reco)
       VALUES ($1, $2, 'NSE', 'buy', $3, $4, 'AWAITING_ENTRY', $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET
         state = 'AWAITING_ENTRY',
         buy_order_id = EXCLUDED.buy_order_id,
         security_id = EXCLUDED.security_id,
         target = EXCLUDED.target,
         sl_trigger = EXCLUDED.sl_trigger,
         capital = EXCLUDED.capital,
         reco = EXCLUDED.reco`,
      [
        v.id,
        v.symbol,
        v.entryPrice,
        v.quantity,
        v.securityId,
        v.symbol,
        buyRes.orderId,
        v.target ?? null,
        v.slTrigger,
        v.capital,
        reco ? JSON.stringify(reco) : null,
      ],
    );

    await audit.info(LifecycleEvents.BUY_PLACED, {
      id: v.id,
      orderId: buyRes.orderId,
      securityId: v.securityId,
      triggerPrice: v.entryPrice,
      quantity: v.quantity,
      state: "AWAITING_ENTRY",
      target: v.target,
      slTrigger: v.slTrigger,
      isForeverOrder: true,
    });

    await audit.notify(
      `📥 AWAITING ENTRY — Buy Order Placed\n` +
        `Symbol: ${v.symbol}\n` +
        `Qty: ${v.quantity} @ ₹${v.entryPrice}\n` +
        `Target: ₹${v.target ?? "—"} | SL: ₹${v.slTrigger}\n` +
        `Order: ${buyRes.orderId} (${buyRes.orderStatus})`,
    );
  }

  // Normalize API payloads (Phase 1): parse strings -> numbers & parse meta_data
  private normalizeActive = (raw: any): ActiveTrade => {
    const asNum = (v: any): number | undefined => {
      if (v === null || v === undefined) return undefined;
      if (typeof v === "number") return v;
      const s = String(v).trim();
      if (!s) return undefined;
      const n = Number(s);
      return Number.isFinite(n) ? n : undefined;
    };

    let meta: any = undefined;
    if (raw.meta_data) {
      try {
        meta = JSON.parse(String(raw.meta_data));
      } catch {}
    }

    const sc_symbol = String(
      raw.sc_symbol || meta?.sc_symbol || "",
    ).toUpperCase();
    const instrument_type_raw = String(
      raw.instrument_type || "cash",
    ).toLowerCase();
    const instrument_type =
      instrument_type_raw === InstrumentType.OPTIONS ? "options" : "cash";
    return {
      id: Number(raw.id),
      reco_id: raw.reco_id ? Number(raw.reco_id) : undefined,
      user_id: raw.user_id ? Number(raw.user_id) : undefined,
      asset_class: "equity",
      instrument_type,
      instrument: raw.instrument ? String(raw.instrument) : undefined,
      reco_type:
        String(raw.reco_type).toLowerCase() === "sell" ? "sell" : "buy",
      reco_category: raw.reco_category || undefined,
      opt_type: raw.opt_type || undefined,
      option_category: raw.option_category || undefined,
      contract_name: raw.contract_name || undefined,
      sc_id: raw.sc_id || undefined,
      sc_symbol,
      sc_name: raw.sc_name || undefined,
      cmp: asNum(raw.cmp ?? meta?.cmp),
      entry_condition: raw.entry_condition || undefined,
      entry_price: asNum(raw.entry_price) ?? 0,
      entry_price_2: asNum(raw.entry_price_2) ?? null,
      target_condition: raw.target_condition || undefined,
      target_price_1: asNum(raw.target_price_1 ?? meta?.target_price_1),
      target_price_2: asNum(raw.target_price_2 ?? meta?.target_price_2),
      stoploss_condition: raw.stoploss_condition || undefined,
      stoploss_price: asNum(raw.stoploss_price ?? meta?.stoploss_price) ?? 0,
      unrealized_pl: asNum(raw.unrealized_pl),
      unrealized_pl_p: asNum(raw.unrealized_pl_p),
      target_return: asNum(raw.target_return),
      chart_snapshots: Array.isArray(raw.chart_snapshots)
        ? raw.chart_snapshots.map(String)
        : undefined,
      rationale: raw.rationale || undefined,
      call_status: raw.call_status || undefined,
      reco_end_date: raw.reco_end_date || undefined,
      updated_at: raw.updated_at || undefined,
      created_at: raw.created_at || undefined,
      updated_at_epoch: raw.updated_at_epoch
        ? Number(raw.updated_at_epoch)
        : undefined,
      created_at_epoch: raw.created_at_epoch
        ? Number(raw.created_at_epoch)
        : undefined,
      closed_on_dt: raw.closed_on_dt || undefined,
      strategy_name_t: raw.strategy_name_t || undefined,
      strategy_name: raw.strategy_name || undefined,
      display_name: raw.display_name || undefined,
      analyst_name: raw.analyst_name || undefined,
      no_of_lots: raw.no_of_lots || undefined,
      lot_size: raw.lot_size || undefined,
      max_stoploss_amount: raw.max_stoploss_amount || undefined,
      meta_data_raw: raw.meta_data || undefined,
      meta: meta
        ? {
            sc_name: meta.sc_name,
            sc_symbol: meta.sc_symbol,
            sc_scripcode: meta.sc_scripcode,
            cmp: asNum(meta.cmp),
            entry_price: asNum(meta.entry_price),
            stoploss_price: asNum(meta.stoploss_price),
            target_price_1: asNum(meta.target_price_1),
            target_price_2: asNum(meta.target_price_2),
          }
        : undefined,
    };
  };

  private normalizeClosed = (raw: any): ClosedTrade => {
    const asNum = (v: any): number | undefined => {
      if (v === null || v === undefined) return undefined;
      if (typeof v === "number") return v;
      const s = String(v).trim();
      if (!s) return undefined;
      const n = Number(s);
      return Number.isFinite(n) ? n : undefined;
    };

    let meta: any = undefined;
    if (raw.meta_data) {
      try {
        meta = JSON.parse(String(raw.meta_data));
      } catch {}
    }

    let history: any = undefined;
    if (raw.history) {
      try {
        history = JSON.parse(String(raw.history));
      } catch {}
    }

    const sc_symbol = String(
      raw.sc_symbol || meta?.sc_symbol || "",
    ).toUpperCase();
    const exitPrice = asNum(raw.exit_price ?? meta?.exit_price);
    const closedOn = raw.closed_on_dt || meta?.closed_on || undefined;

    const instrument_type_raw = String(
      raw.instrument_type || "cash",
    ).toLowerCase();
    const instrument_type =
      instrument_type_raw === InstrumentType.OPTIONS ? "options" : "cash";

    return {
      id: Number(raw.id),
      reco_id: raw.reco_id ? Number(raw.reco_id) : undefined,
      user_id: raw.user_id ? Number(raw.user_id) : undefined,
      asset_class: "equity",
      instrument_type: "cash",
      instrument: raw.instrument ? String(raw.instrument) : undefined,
      reco_type:
        String(raw.reco_type).toLowerCase() === "sell" ? "sell" : "buy",
      reco_category: raw.reco_category || undefined,
      opt_type: raw.opt_type || undefined,
      option_category: raw.option_category || undefined,
      contract_name: raw.contract_name || undefined,
      sc_id: raw.sc_id || undefined,
      sc_symbol,
      sc_name: raw.sc_name || undefined,
      cmp: asNum(raw.cmp ?? meta?.cmp),
      entry_condition: raw.entry_condition || undefined,
      entry_price: asNum(raw.entry_price) ?? 0,
      entry_price_2: asNum(raw.entry_price_2) ?? null,
      target_condition: raw.target_condition || undefined,
      target_price_1: asNum(raw.target_price_1 ?? meta?.target_price_1),
      target_price_2: asNum(raw.target_price_2 ?? meta?.target_price_2),
      stoploss_condition: raw.stoploss_condition || undefined,
      stoploss_price: asNum(raw.stoploss_price ?? meta?.stoploss_price),
      unrealized_pl: asNum(raw.unrealized_pl),
      unrealized_pl_p: asNum(raw.unrealized_pl_p),
      target_return: asNum(raw.target_return),
      chart_snapshots: Array.isArray(raw.chart_snapshots)
        ? raw.chart_snapshots.map(String)
        : undefined,
      rationale: raw.rationale || undefined,
      call_status: raw.call_status || undefined,
      reco_end_date: raw.reco_end_date || undefined,
      updated_at: raw.updated_at || undefined,
      created_at: raw.created_at || undefined,
      updated_at_epoch: raw.updated_at_epoch
        ? Number(raw.updated_at_epoch)
        : undefined,
      created_at_epoch: raw.created_at_epoch
        ? Number(raw.created_at_epoch)
        : undefined,
      closed_on_dt: closedOn,
      analyst_name: raw.analyst_name || undefined,
      display_name: raw.display_name || undefined,
      history_raw: raw.history || undefined,
      history: Array.isArray(history) ? history : undefined,
      meta_data_raw: raw.meta_data || undefined,
      meta: meta
        ? {
            sc_name: meta.sc_name,
            sc_symbol: meta.sc_symbol,
            sc_scripcode: meta.sc_scripcode,
            cmp: asNum(meta.cmp),
            entry_price: asNum(meta.entry_price),
            entry_price_2: asNum(meta.entry_price_2),
            stoploss_price: asNum(meta.stoploss_price),
            target_price_1: asNum(meta.target_price_1),
            target_price_2: asNum(meta.target_price_2),
            exit_price: asNum(meta.exit_price),
            exit_price_condition: meta.exit_price_condition,
            isclosed: !!meta.isclosed,
            status: meta.status,
            closed_on: meta.closed_on,
            realized_pl_p: asNum(meta.realized_pl_p),
          }
        : undefined,
      exit_price: exitPrice,
    };
  };
}
