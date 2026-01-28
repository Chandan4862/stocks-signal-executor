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
  idempotency: (action: "buy" | "sell" | "gtt", id: number | string) =>
    `idempotency:${action}:${id}`,
  trade: (id: number | string) => `trade:${id}`,
  tsl: (id: number | string) => `tsl:${id}`,
  marketHealth: () => `health:market`,
};
