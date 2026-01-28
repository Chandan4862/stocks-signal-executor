/*
 TSLService: Trailing stop logic. If CMP rises, adjust SL upward.
 Phase 1: Strategy placeholders only.
*/

export class TSLService {
  constructor(
    private cfg: {
      incrementRs: number;
      initialSlPct: number;
      trailingStepPct: number;
    }
  ) {}

  initialStopLoss(entryPrice: number): number {
    const delta = (this.cfg.initialSlPct / 100) * entryPrice;
    return Math.max(0, Math.round((entryPrice - delta) * 100) / 100);
  }

  // Example strategy: bump SL by fixed Rs on each trailing step
  nextStopLoss(currentSl: number, cmp: number): number {
    const proposed = Math.min(cmp - 0.05, currentSl + this.cfg.incrementRs); // never above CMP
    return proposed <= currentSl ? currentSl : proposed;
  }
}
