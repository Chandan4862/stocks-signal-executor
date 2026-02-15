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
        const buyRes = await this.placeEntryOrder(dhan, validated, at);

        // Persist state (idempotency, snapshot, audit)
        await this.persistBuyState(store, audit, validated, buyRes);
        openCount++;

        // Legacy mode: place separate SL leg
        if (!this.cfg.useSuperOrder) {
          await this.placeLegacyStopLoss(store, dhan, audit, validated);
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

    // Resolve entry price
    const entryPrice =
      (typeof at.entry_price === "number" ? at.entry_price : undefined) ??
      at.cmp ??
      0;
    if (!entryPrice || entryPrice <= 0) {
      audit.record(LifecycleEvents.ERROR_OCCURRED, {
        id,
        reason: "Invalid entry price",
        entryPrice,
      });
      return null;
    }

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
      entryPrice,
      quantity: qty,
      capital,
      slTrigger,
      target,
    };
  }

  /**
   * Place entry order: super order (BUY+SL+target combined) or legacy BUY MARKET.
   */
  private async placeEntryOrder(
    dhan: DhanService,
    v: ValidatedTrade,
    at: ActiveTrade,
  ): Promise<PlaceOrderResponse> {
    if (this.cfg.useSuperOrder) {
      const superReq: PlaceSuperOrderRequest = {
        dhanClientId: this.cfg.dhan.clientId,
        correlationId: `buy:${v.id}`,
        transactionType: "BUY",
        exchangeSegment: "NSE_EQ",
        productType: "CNC",
        orderType: "LIMIT",
        securityId: v.securityId,
        quantity: v.quantity,
        price: v.entryPrice,
        targetPrice: v.target,
        stopLossPrice: v.slTrigger,
        trailingJump: this.cfg.tsl.incrementRs,
      };
      return dhan.placeSuperOrder(superReq);
    }

    const buyReq: PlaceOrderRequest = {
      dhanClientId: this.cfg.dhan.clientId,
      correlationId: `buy:${v.id}`,
      transactionType: "BUY",
      exchangeSegment: "NSE_EQ",
      productType: "CNC",
      orderType: "MARKET",
      validity: "DAY",
      securityId: v.securityId,
      quantity: v.quantity,
    };
    return dhan.placeOrder(buyReq);
  }

  /**
   * Persist BUY state: set idempotency key, cache trade snapshot, record audit.
   */
  private async persistBuyState(
    store: StateStore,
    audit: AuditLogService,
    v: ValidatedTrade,
    buyRes: PlaceOrderResponse,
  ): Promise<void> {
    await store.redis.set(RedisKeys.idempotencyBuy(v.id), "1", "EX", 86400);
    await store.redis.set(
      RedisKeys.trade(v.id),
      JSON.stringify({
        id: v.id,
        securityId: v.securityId,
        entry_price: v.entryPrice,
        quantity: v.quantity,
        state: "OPEN",
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
      entryPrice: v.entryPrice,
      quantity: v.quantity,
    });
  }

  /**
   * Legacy mode only: place a separate SL-M (Stop Loss Market) order after BUY.
   */
  private async placeLegacyStopLoss(
    store: StateStore,
    dhan: DhanService,
    audit: AuditLogService,
    v: ValidatedTrade,
  ): Promise<void> {
    const slGuardSet = await store.redis.set(
      RedisKeys.idempotencySl(v.id),
      "1",
      "EX",
      86400,
      "NX",
    );
    if (!slGuardSet) return;

    const slReq: PlaceOrderRequest = {
      dhanClientId: this.cfg.dhan.clientId,
      correlationId: `sl:${v.id}`,
      transactionType: "SELL",
      exchangeSegment: "NSE_EQ",
      productType: "CNC",
      orderType: "STOP_LOSS_MARKET",
      validity: "DAY",
      securityId: v.securityId,
      quantity: v.quantity,
      triggerPrice: v.slTrigger,
    };
    const slRes = await dhan.placeOrder(slReq);
    await store.redis.set(
      RedisKeys.tsl(v.id),
      JSON.stringify({
        slOrderId: slRes.orderId,
        triggerPrice: v.slTrigger,
        lastUpdatedAt: Date.now(),
      }),
      "EX",
      86400,
    );
    await audit.record(LifecycleEvents.GTT_PLACED, {
      id: v.id,
      req: slReq,
      res: slRes,
    });
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
