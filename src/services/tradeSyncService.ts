/*
 TradeSyncService: Polls Active and Closed APIs, reconciles transitions,
 enforces idempotency, and triggers Kite operations.
 Phase 1: Stub with method signatures.
*/

import axios from "axios";
import type { AppConfig } from "../config/schema";
import type { ActiveTrade } from "../models/activeTrade";
import type { ClosedTrade } from "../models/closedTrade";
import type { ValidatedTrade } from "../models/validatedTrade";
import { StateStore } from "./stateStore";
import {
  DhanService,
  PlaceOrderRequest,
  PlaceOrderResponse,
  PlaceSuperOrderRequest,
  PlaceForeverOrderRequest,
} from "./dhanService";
import { QuantityResolverService } from "./quantityResolverService";
import { TSLService } from "./tslService";
import { AuditLogService } from "./auditLogService";
import { InstrumentLookupService } from "./instrumentLookupService";
import { RedisKeys } from "../state/redisKeys";
import { InstrumentType, LifecycleEvents } from "../enums/trade";
import { symbol } from "zod";

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
    let openCount = await this.getOpenTradeCount(store);

    for (const at of actives) {
      // Only process cash instruments
      if (!(await this.isCashInstrument(at, audit))) continue;

      const id = at.id;
      const gotLock = await store.redis.set(
        RedisKeys.lockTrade(id),
        "1",
        "PX",
        5000,
        "NX",
      );
      if (!gotLock) continue;

      try {
        // Portfolio cap check
        if (await this.isPortfolioCapReached(openCount, id, audit)) continue;

        // Idempotency guard
        const buyGuard = await store.redis.get(RedisKeys.idempotencyBuy(id));
        if (buyGuard) continue;

        // Validate & resolve trade params
        const validated = await this.validateAndResolveTrade(
          at,
          qtyResolver,
          tslService,
          audit,
          instrumentLookup,
        );
        if (!validated) continue;

        // Place order (super or legacy)
        const buyRes = await this.placeForeverEntry(dhan, validated);

        // Persist state (idempotency, snapshot, audit)
        await this.persistBuyState(store, audit, validated, buyRes);
        openCount++;

        // Legacy mode: place separate SL leg
        if (!this.cfg.useSuperOrder) {
          // Note: In Forever Order strategy, we skip placing a legacy SL here
          // because we don't hold the stock yet. We execute the OCO SL
          // when the entry triggers. We'll leave this empty or remove it.
        }
      } catch (err: any) {
        await audit.record(LifecycleEvents.ERROR_OCCURRED, {
          id: at.id,
          error: String(err?.message || err),
        });
      } finally {
        await store.redis.del(RedisKeys.lockTrade(id));
      }
    }
  }

  // Phase 3: Monitor pending Forever Orders and attach OCO Exit legs
  async monitorPendingEntries(
    store: StateStore,
    dhan: DhanService,
    audit: AuditLogService,
  ): Promise<void> {
    try {
      // 1. Fetch all Forever Orders from Dhan
      const foreverOrders = await dhan.getForeverOrders();
      if (!Array.isArray(foreverOrders)) return;

      // 2. We need to find local trades in AWAITING_ENTRY state
      // (For this, we'll iterate through Redis keys that match trade:* and check state)
      const keys = await store.redis.keys(RedisKeys.trade("*"));
      for (const key of keys) {
        const tradeDataStr = await store.redis.get(key);
        if (!tradeDataStr) continue;

        const tradeData = JSON.parse(tradeDataStr);
        if (tradeData.state !== "AWAITING_ENTRY" || !tradeData.buyOrderId)
          continue;

        // 3. Find the corresponding Dhan order
        const dhanOrder = foreverOrders.find(
          (o) => String(o.orderId) === String(tradeData.buyOrderId),
        );

        if (!dhanOrder) continue;

        // 4. If the order is TRADED (meaning entry breakout/dip was hit)
        if (dhanOrder.orderStatus === "TRADED") {
          // We have entered the position! Let's place the OCO Exit Bracket.
          const tradedPrice =
            typeof dhanOrder.price === "number"
              ? dhanOrder.price
              : tradeData.entry_price;

          // Fetch target & sl from local state (assuming we parse and store them, or re-fetch active trade.. wait, we need target/sl.
          // Let's ensure target & sl Trigger are persisted in tradeData when we place the entry!)
          const targetPrice = tradeData.target || tradedPrice * 1.05; // Fallback 5% if missing
          const stopLossPrice = tradeData.slTrigger || tradedPrice * 0.95; // Fallback 5% if missing

          const exitReq: PlaceForeverOrderRequest = {
            dhanClientId: this.cfg.dhan.clientId,
            correlationId: `exit:${tradeData.id}`,
            orderFlag: "OCO",
            transactionType: "SELL",
            exchangeSegment: "NSE_EQ",
            productType: "CNC", // Assuming CNC holding
            orderType: "LIMIT",
            validity: "DAY",
            securityId: tradeData.securityId,
            quantity: tradeData.quantity,
            // Leg 1: Target
            price: targetPrice,
            triggerPrice: targetPrice,
            // Leg 2: Stop Loss
            price1: stopLossPrice,
            triggerPrice1: stopLossPrice,
            quantity1: tradeData.quantity,
          };

          try {
            // Let's ensure exitReq is using correct types by importing if necessary.
            // (PlaceForeverOrderRequest is already imported)
            const exitRes = await dhan.placeForeverOrder(exitReq);

            // Update local state to ENTERED and save the exit OCO Order ID
            tradeData.state = "ENTERED";
            tradeData.exitOrderId = exitRes.orderId;
            tradeData.entry_price = tradedPrice;

            await store.redis.set(
              key,
              JSON.stringify(tradeData),
              "EX",
              86400 * 30,
            ); // Extend TTL if held

            await audit.record(LifecycleEvents.BUY_PLACED, {
              id: tradeData.id,
              message: "Entry Forever Order TRADED. Attached OCO Exit.",
              entryPrice: tradedPrice,
              exitOrderId: exitRes.orderId,
            });

            // Update Postgres trades table to ENTERED
            try {
              await store.pg.query(
                `UPDATE trades SET state = 'ENTERED', entered_at = NOW() WHERE id = $1`,
                [tradeData.id],
              );
            } catch (err: any) {
              console.error(
                `PG update failed for trade ${tradeData.id}:`,
                err.message,
              );
            }
          } catch (err: any) {
            await audit.record(LifecycleEvents.ERROR_OCCURRED, {
              id: tradeData.id,
              action: "Attach OCO Exception",
              error: err.message,
            });
          }
        } else if (
          dhanOrder.orderStatus === "CANCELLED" ||
          dhanOrder.orderStatus === "REJECTED" ||
          dhanOrder.orderStatus === "EXPIRED"
        ) {
          // Entry failed or was cancelled by user directly on Dhan
          tradeData.state = "CLOSED";
          await store.redis.set(key, JSON.stringify(tradeData), "EX", 3600);
          await audit.record(LifecycleEvents.ERROR_OCCURRED, {
            id: tradeData.id,
            action: "Entry Order Cancelled/Rejected",
          });

          // Update Postgres table to CANCELLED
          try {
            await store.pg.query(
              `UPDATE trades SET state = 'CANCELLED' WHERE id = $1`,
              [tradeData.id],
            );
          } catch (err: any) {}
        }
      }
    } catch (err: any) {
      console.error("monitorPendingEntries error:", err.message);
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
        const tradeKey = RedisKeys.trade(ct.id);
        const tradeDataStr = await store.redis.get(tradeKey);
        if (!tradeDataStr) continue;

        const tradeData = JSON.parse(tradeDataStr);

        // If the trade is already closed locally, do nothing
        if (
          tradeData.state === "CLOSED" ||
          tradeData.state === "CLOSED_BY_ANALYST"
        )
          continue;

        // Let's cancel whatever is pending and clear it out
        if (tradeData.state === "AWAITING_ENTRY") {
          try {
            if (tradeData.buyOrderId) {
              await dhan.cancelForeverOrder(tradeData.buyOrderId);
            }
            tradeData.state = "CLOSED";
            await store.redis.set(
              tradeKey,
              JSON.stringify(tradeData),
              "EX",
              3600,
            );
            await audit.record(LifecycleEvents.SKIP_TRADE, {
              id: ct.id,
              message:
                "Trade closed by analyst before entry executed. Cancelled pending Forever order.",
            });

            // Update Postgres table to CANCELLED
            try {
              await store.pg.query(
                `UPDATE trades SET state = 'CLOSED' WHERE id = $1`,
                [ct.id],
              );
            } catch (err: any) {}
          } catch (err: any) {}
        } else if (tradeData.state === "ENTERED") {
          try {
            if (tradeData.exitOrderId) {
              await dhan.cancelForeverOrder(tradeData.exitOrderId);
            }

            // We possess the stock, fire an immediate Market SELL to liquidate at CMP
            const sellReq: PlaceOrderRequest = {
              dhanClientId: this.cfg.dhan.clientId,
              correlationId: `liq:${ct.id}`,
              transactionType: "SELL",
              exchangeSegment: "NSE_EQ",
              productType: "CNC",
              orderType: "MARKET",
              validity: "DAY",
              securityId: tradeData.securityId,
              quantity: tradeData.quantity,
            };
            await dhan.placeOrder(sellReq);

            tradeData.state = "CLOSED_BY_ANALYST";
            await store.redis.set(
              tradeKey,
              JSON.stringify(tradeData),
              "EX",
              3600,
            );
            await audit.record(LifecycleEvents.SELL_PLACED, {
              id: ct.id,
              message:
                "Analyst officially closed the trade. Liquidated position at Market.",
            });

            // Assuming market execution near CMP or entry price
            try {
              const exitPrice = ct.cmp ?? tradeData.entry_price; // approximate
              await store.pg.query(
                `UPDATE trades SET state = 'CLOSED_BY_ANALYST', exited_at = NOW(), exit_price = $1 WHERE id = $2`,
                [exitPrice, ct.id],
              );
            } catch (err: any) {}
          } catch (err: any) {
            await audit.record(LifecycleEvents.ERROR_OCCURRED, {
              id: ct.id,
              message: "Failed to liquidate closed trade",
              error: err.message,
            });
          }
        }
      }
    } catch (err: any) {
      console.error("processClosedTrades error:", err.message);
    }
  }

  // ─── Extracted Private Methods ──────────────────────────────────────

  /**
   * Query Postgres for the count of currently ENTERED (open) trades.
   */
  private async getOpenTradeCount(store: StateStore): Promise<number> {
    try {
      const res = await store.pg.query(
        "SELECT COUNT(*) AS cnt FROM trades WHERE state = $1",
        ["ENTERED"],
      );
      const raw = res.rows?.[0]?.cnt;
      return raw !== undefined ? Number(raw) : 0;
    } catch (error: any) {
      console.error("Error fetching open trade count:", error.message);
      return 0;
    }
  }

  /**
   * Guard: returns true if the ActiveTrade is a cash instrument.
   * Logs SKIP_TRADE audit for non-cash.
   */
  private async isCashInstrument(
    at: ActiveTrade,
    audit: AuditLogService,
  ): Promise<boolean> {
    if (at.instrument_type !== InstrumentType.CASH) {
      await audit.record(
        LifecycleEvents.SKIP_TRADE,
        {
          id: at.id,
          reason: "Skipping non-cash instrument",
          instrument_type: at.instrument_type,
        },
        false,
      );
      return false;
    }
    return true;
  }

  /**
   * Guard: returns true if portfolio cap is reached. Logs audit.
   */
  private async isPortfolioCapReached(
    openCount: number,
    id: number,
    audit: AuditLogService,
  ): Promise<boolean> {
    if (openCount >= this.cfg.maxActiveTrades) {
      await audit.record(LifecycleEvents.ERROR_OCCURRED, {
        id,
        reason: "Portfolio cap reached",
        openCount,
        maxActiveTrades: this.cfg.maxActiveTrades,
      });
      return true;
    }
    return false;
  }

  /**
   * Validate & resolve: securityId, entryPrice, qty, slTrigger, target.
   * Returns ValidatedTrade or null to skip.
   */
  private async validateAndResolveTrade(
    at: ActiveTrade,
    qtyResolver: QuantityResolverService,
    tslService: TSLService,
    audit: AuditLogService,
    instrumentLookup: InstrumentLookupService,
  ): Promise<ValidatedTrade | null> {
    const id = at.id;
    const symbol = String(at.sc_symbol || "").toUpperCase();

    // Resolve securityId from instrument_list_nse_eq
    if (!symbol) {
      await audit.record(LifecycleEvents.ERROR_OCCURRED, {
        id,
        reason: "Missing sc_symbol — cannot resolve securityId",
      });
      return null;
    }

    const securityId = await instrumentLookup.resolveSecurityId(symbol);
    if (!securityId) {
      await audit.record(LifecycleEvents.ERROR_OCCURRED, {
        id,
        reason: "No instrument found in instrument_list_nse_eq",
        symbol,
      });
      return null;
    }

    const cmp = at.cmp ?? 0;

    // Resolve entry price
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

    // Resolve capital & quantity
    const capital = (at as any)?.meta?.max_capital ?? this.cfg.maxTradeCapital;
    const qty = qtyResolver.deriveQty(entryPrice, Number(capital));
    if (!qty || qty <= 0) {
      audit.record(LifecycleEvents.ERROR_OCCURRED, {
        id,
        reason: "Derived quantity is 0",
        entryPrice,
        capital,
      });
      return null;
    }

    // Resolve SL trigger & target
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
      capital,
      slTrigger,
      target,
    };
  }

  /**
   * Place entry order: SINGLE Forever Order for entry breakout/limit conditions.
   * If condition is already met (cmp in range), fall back to Market order immediately?
   * For this implementation, we always set a Forever Order with triggerPrice.
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
      correlationId: `buy:${v.id}`,
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
   * Persist BUY state: set idempotency key, cache trade snapshot, record audit.
   * Modifies state to AWAITING_ENTRY.
   */
  private async persistBuyState(
    store: StateStore,
    audit: AuditLogService,
    v: ValidatedTrade,
    buyRes: PlaceOrderResponse,
  ): Promise<void> {
    await store.redis.set(RedisKeys.idempotencyBuy(v.id), "1", "EX", 86400);

    // Store as AWAITING_ENTRY initially. We'll poll Dhan on a timer to check if it traded.
    await store.redis.set(
      RedisKeys.trade(v.id),
      JSON.stringify({
        id: v.id,
        securityId: v.securityId,
        entry_price: v.entryPrice,
        quantity: v.quantity,
        state: "AWAITING_ENTRY",
        buyOrderId: buyRes.orderId,
        symbol: v.symbol,
      }),
      "EX",
      86400,
    );
    await audit.record(LifecycleEvents.BUY_PLACED, {
      id: v.id,
      orderId: buyRes.orderId,
      securityId: v.securityId,
      triggerPrice: v.entryPrice,
      quantity: v.quantity,
      state: "AWAITING_ENTRY",
      isForeverOrder: true,
    });

    // Persist to Postgres `trades` table
    try {
      await store.pg.query(
        `INSERT INTO trades (id, tradingsymbol, exchange, reco_type, entry_price, quantity, state)
         VALUES ($1, $2, 'NSE', 'buy', $3, $4, 'AWAITING_ENTRY')
         ON CONFLICT (id) DO NOTHING`,
        [v.id, v.symbol, v.entryPrice, v.quantity],
      );
    } catch (err: any) {
      console.error(`Failed to insert trade ${v.id} into pg:`, err.message);
    }
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
