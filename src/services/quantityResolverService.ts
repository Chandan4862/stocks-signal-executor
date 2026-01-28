/*
 QuantityResolverService: Determines quantity from entry price and max capital.
 Round down to nearest whole share.
*/

export class QuantityResolverService {
  deriveQty(entryPrice: number, maxCapital: number): number {
    if (entryPrice <= 0) return 0;
    const qty = Math.floor(maxCapital / entryPrice);
    return Math.max(0, qty);
  }
}
