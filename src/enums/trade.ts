export enum TradeState {
  NEW = "NEW", // discovered active recommendation, not yet entered
  ENTERED = "ENTERED", // buy executed
  EXITED = "EXITED", // sell executed
  CANCELLED = "CANCELLED", // invalidated or cancelled before entry
}

export enum OrderState {
  INITIATED = "INITIATED",
  PLACED = "PLACED",
  EXECUTED = "EXECUTED",
  CANCELLED = "CANCELLED",
  REJECTED = "REJECTED",
  FAILED = "FAILED",
}

export enum LifecycleEvents {
  BUY_PLACED = "BUY_PLACED",
  GTT_PLACED = "GTT_PLACED",
  TSL_UPDATED = "TSL_UPDATED",
  SELL_PLACED = "SELL_PLACED",
  GTT_CANCELLED = "GTT_CANCELLED",
  EXIT_RECORDED = "EXIT_RECORDED",
  TOKEN_REFRESHED = "TOKEN_REFRESHED",
  ACTIVE_TRADE_SYNCED = "ACTIVE_TRADE_SYNCED",
  CLOSED_TRADE_SYNCED = "CLOSED_TRADE_SYNCED",
  ERROR_OCCURRED = "ERROR_OCCURRED",
  SKIP_TRADE = "SKIP_TRADE",
}

export enum InstrumentType {
  CASH = "cash",
  OPTIONS = "options",
}
