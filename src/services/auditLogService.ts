/*
 AuditLogService: Immutable event journal (Phase 1: stub).
*/

import { LifecycleEvents } from "../enums/trade";

export class AuditLogService {
  async record(
    event: LifecycleEvents,
    payload: Record<string, any>
  ): Promise<void> {
    // TODO (Phase 2): persist to Postgres
    console.log("AUDIT", event, payload);
  }
}
