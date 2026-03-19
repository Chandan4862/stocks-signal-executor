/*
  TradeEntryService: Phase 2 — Discover new active trades and place
  SINGLE Forever entry orders on Dhan.
  Handles validation, quantity resolution, capital guards, and order placement.
*/

import type { AppConfig } from "../config/schema";
import type { ActiveTrade } from "../models/activeTrade";
import type { ValidatedTrade } from "../models/validatedTrade";
import { StateStore } from "./stateStore";
import {
  DhanService,
  DhanApiError,
  PlaceOrderResponse,
  PlaceForeverOrderRequest,
} from "./dhanService";
import { QuantityResolverService } from "./quantityResolverService";
import { TSLService } from "./tslService";
import { AuditLogService } from "./auditLogService";
import { InstrumentLookupService } from "./instrumentLookupService";
import { InstrumentType, LifecycleEvents } from "../enums/trade";

export class TradeEntryService {
  constructor(private cfg: AppConfig) {}

  // Phase 2: Run BUY + initial SL placement for newly discovered active trades
  async runBuyAndInitialSl(
    store: StateStore,
    dhan: DhanService,
    qtyResolver: QuantityResolverService,
    tslService: TSLService,
    audit: AuditLogService,
    instrumentLookup: InstrumentLookupService,
    actives: ActiveTrade[],
  ): Promise<void> {
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

  // ─── Private Methods ──────────────────────────────────────────────────

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
}
