/**
 * HolidayService: checks whether the market is closed today
 * (weekend or DB-listed holiday).
 *
 * Used by Scheduler to skip trading methods on non-market days
 * and send Telegram notifications for named holidays.
 */

import { DateTime } from "luxon";
import type { Client } from "pg";

export interface MarketClosedResult {
  /** true if market is closed (weekend or holiday) */
  closed: boolean;
  /** 'weekend' | 'holiday' */
  type?: "weekend" | "holiday";
  /** Human-readable reason, e.g. "Weekend (Saturday)" or "Republic Day" */
  reason?: string;
}

export class HolidayService {
  private static readonly IST = "Asia/Kolkata";

  constructor(private pg: Client) {}

  /**
   * Check if a specific date is a market holiday (from DB).
   * Returns the holiday description if found.
   */
  async getHoliday(date: Date): Promise<{ isHoliday: boolean; description?: string }> {
    const dateStr = DateTime.fromJSDate(date).setZone(HolidayService.IST).toFormat("yyyy-MM-dd");

    const result = await this.pg.query(
      "SELECT description FROM market_holidays WHERE holiday_date = $1",
      [dateStr],
    );

    if (result.rows.length > 0) {
      return { isHoliday: true, description: result.rows[0].description };
    }
    return { isHoliday: false };
  }

  /**
   * Check if today (IST) is a non-trading day — weekend OR holiday.
   *
   * Returns:
   *  - Weekend Saturday/Sunday → { closed: true, type: 'weekend', reason: 'Weekend (Saturday)' }
   *  - Holiday                 → { closed: true, type: 'holiday', reason: 'Republic Day' }
   *  - Normal trading day      → { closed: false }
   */
  async isMarketClosed(): Promise<MarketClosedResult> {
    const now = DateTime.now().setZone(HolidayService.IST);
    const weekday = now.weekday; // 1=Mon … 6=Sat, 7=Sun

    // Check weekend first (no DB hit needed)
    if (weekday === 6) return { closed: true, type: "weekend", reason: "Weekend (Saturday)" };
    if (weekday === 7) return { closed: true, type: "weekend", reason: "Weekend (Sunday)" };

    // Check DB for named holidays
    const holiday = await this.getHoliday(now.toJSDate());
    if (holiday.isHoliday) {
      return { closed: true, type: "holiday", reason: holiday.description };
    }

    return { closed: false };
  }
}
