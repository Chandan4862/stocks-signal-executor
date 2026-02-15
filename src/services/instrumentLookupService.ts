/**
 * InstrumentLookupService: Resolves Dhan security_id from the
 * instrument_list_nse_eq table using the underlying symbol.
 *
 * Single Responsibility: instrument identity resolution only.
 */

import type { Client } from "pg";

export class InstrumentLookupService {
  constructor(private pg: Client) {}

  /**
   * Look up the Dhan security_id for an NSE equity symbol.
   * Queries: instrument_type = 'ES' AND underlying_symbol = <symbol>
   * Returns the security_id string, or null if not found.
   */
  async resolveSecurityId(symbol: string): Promise<string | null> {
    const { rows } = await this.pg.query(
      `SELECT security_id FROM instrument_list_nse_eq
       WHERE instrument_type = 'ES' AND underlying_symbol = $1
       LIMIT 1`,
      [symbol.toUpperCase()],
    );
    return rows.length > 0 ? String(rows[0].security_id) : null;
  }
}
