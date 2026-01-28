/*
 TradeSyncService: Polls Active and Closed APIs, reconciles transitions,
 enforces idempotency, and triggers Kite operations.
 Phase 1: Stub with method signatures.
*/

import axios from "axios";
import type { AppConfig } from "../config/schema";
import type { ActiveTrade } from "../models/activeTrade";
import type { ClosedTrade } from "../models/closedTrade";

export class TradeSyncService {
  constructor(private cfg: AppConfig) {}

  async fetchActiveTrades(): Promise<ActiveTrade[]> {
    const { data } = await axios.get(this.cfg.apis.activeTradesUrl);
    return (data as any[]).map(this.normalizeActive);
  }

  async fetchClosedTrades(): Promise<ClosedTrade[]> {
    const { data } = await axios.get(this.cfg.apis.closedTradesUrl);
    return (data as any[]).map(this.normalizeClosed);
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
