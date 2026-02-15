export interface ActiveTrade {
  id: number;
  reco_id?: number;
  user_id?: number;
  asset_class: "equity";
  instrument_type: "cash" | "options";
  instrument?: string; // e.g., STK
  reco_type: "buy" | "sell";
  reco_category?: string;
  opt_type?: string;
  option_category?: string;
  contract_name?: string;
  sc_id?: string;
  sc_symbol: string;
  sc_name?: string;

  cmp?: number;

  entry_condition?: string;
  entry_price: number;
  entry_price_2?: number | null;

  target_condition?: string;
  target_price_1?: number;
  target_price_2?: number | null;

  stoploss_condition?: string;
  stoploss_price: number;

  unrealized_pl?: number;
  unrealized_pl_p?: number;
  target_return?: number;

  chart_snapshots?: string[];
  rationale?: string;
  call_status?: string;
  reco_end_date?: string;

  updated_at?: string;
  created_at?: string;
  updated_at_epoch?: number;
  created_at_epoch?: number;
  closed_on_dt?: string;

  strategy_name_t?: string;
  strategy_name?: string;
  display_name?: string;
  analyst_name?: string;

  no_of_lots?: string;
  lot_size?: string;
  max_stoploss_amount?: string;

  meta_data_raw?: string;
  meta?: {
    sc_name?: string;
    sc_symbol?: string;
    sc_scripcode?: string;
    cmp?: number;
    entry_price?: number;
    stoploss_price?: number;
    target_price_1?: number;
    target_price_2?: number;
    // additional parsed fields as needed
  };
}
