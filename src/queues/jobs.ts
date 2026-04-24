/*
  Job type definitions for all BullMQ queues.
  Every job carries userId for tenant isolation + traceId for debugging.
*/

import type { ActiveTrade } from "../models/activeTrade";
import type { ClosedTrade } from "../models/closedTrade";

/** Base interface — all jobs carry these fields */
export interface BaseJob {
  userId: number;
  traceId: string;
  enqueuedAt: string; // ISO timestamp
}

/** Signal fanout: fetched once by scheduler, fanned out to per-user execution jobs */
export interface SignalFanoutJob extends BaseJob {
  phase: "ACTIVE_SCAN" | "CLOSED_SCAN";
  signals: ActiveTrade[] | ClosedTrade[];
}

/** Trade execution: one job per (user × signal) pair */
export interface TradeExecutionJob extends BaseJob {
  phase: "ENTRY";
  signal: ActiveTrade;
}

/** Trade monitor: one job per user per monitor cycle */
export interface TradeMonitorJob extends BaseJob {
  phase: "PENDING_ENTRIES" | "ENTERED_TRADES";
}

/** Reconciliation: one job per user */
export interface ReconciliationJob extends BaseJob {
  phase: "CLOSED_TRADES" | "POSITION_RECONCILE";
  closedSignals?: ClosedTrade[];
}

/** Notification: one Telegram message per job */
export interface NotificationJob extends BaseJob {
  chatId?: string; // explicit override (optional)
  text: string;
  parseMode?: "MarkdownV2" | "HTML";
  channel: "default" | "trades" | "admin";
}

/** Token renewal: one job per user */
export interface TokenRenewalJob extends BaseJob {
  action: "PROACTIVE_RENEW" | "GENERATE_TOTP" | "VALIDATE";
}

// ─── Job ID Helpers ────────────────────────────────────────────────

/**
 * Generate a deterministic job ID for idempotent enqueueing.
 * BullMQ deduplicates by jobId — same ID = same job, won't re-enqueue.
 */
export function makeJobId(parts: (string | number)[]): string {
  return parts.join("-");
}

/**
 * Generate today's date key in YYYY-MM-DD format (IST).
 */
export function todayKey(): string {
  const now = new Date();
  // Simple IST offset (+5:30)
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}
