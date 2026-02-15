/*
 Redis Key Strategy (Phase 1):
 - token:{date} -> enctoken for trading day (YYYY-MM-DD)
 - idempotency:{action}:{id} -> set for buy/sell/gtt actions
 - trade:{id} -> active trade state cache (serialized ExecutedTrade)
 - tsl:{id} -> TSL intermediate state (current SL, last cmp)
 - health:market -> market status (halted/resumed)
*/

export const RedisKeys = {
  tokenForDate: (dateStr: string) => `token:${dateStr}`,
  brokerToken: () => `broker:token`,
  idempotencyBuy: (id: number | string) => `idempotency:buy:${id}`,
  idempotencySell: (id: number | string) => `idempotency:sell:${id}`,
  idempotencySl: (id: number | string) => `idempotency:sl:${id}`,
  idempotencyTsl: (id: number | string, trigger: number | string) =>
    `idempotency:tsl:${id}:${trigger}`,
  trade: (id: number | string) => `trade:${id}`,
  tsl: (id: number | string) => `tsl:${id}`,
  lockTrade: (id: number | string) => `lock:trade:${id}`,
  marketHealth: () => `health:market`,
};
