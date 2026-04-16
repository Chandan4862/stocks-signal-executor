/*
 AuditLogService: Centralized event journal with level-based routing.

 Routing matrix:
   DEBUG    → console only
   INFO     → console + Postgres
   WARN     → console + Postgres
   ERROR    → console + Postgres + notification queue (→ Telegram)
   CRITICAL → console + Postgres + notification queue (→ Telegram)

 Notifications are enqueued to BullMQ (never sent directly).
 The NotificationWorker is the sole Telegram sender.
*/

import type { Client, Pool } from "pg";
import type { Queue } from "bullmq";
import { LifecycleEvents, LogLevel } from "../enums/trade";
import type { NotificationJob } from "../queues/jobs";

const LEVEL_LABELS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "DEBUG",
  [LogLevel.INFO]: "INFO",
  [LogLevel.WARN]: "WARN",
  [LogLevel.ERROR]: "ERROR",
  [LogLevel.CRITICAL]: "CRITICAL",
};

const LEVEL_EMOJI: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "🔍",
  [LogLevel.INFO]: "ℹ️",
  [LogLevel.WARN]: "⚠️",
  [LogLevel.ERROR]: "❌",
  [LogLevel.CRITICAL]: "🔴",
};

export class AuditLogService {
  private pg: Client | Pool | null;
  private notifQueue: Queue<NotificationJob> | null;
  private userId: number | null;

  constructor(
    pg?: Client | Pool | null,
    notifQueue?: Queue<NotificationJob> | null,
    userId?: number | null,
  ) {
    this.pg = pg ?? null;
    this.notifQueue = notifQueue ?? null;
    this.userId = userId ?? null;
  }

  /** Create a user-scoped copy of this service. */
  forUser(userId: number): AuditLogService {
    return new AuditLogService(this.pg, this.notifQueue, userId);
  }

  /* ------------------------------------------------------------------ */
  /*  Main API                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Record an event with a specific log level.
   *
   * Routing:
   *   DEBUG    → console only
   *   INFO     → console + DB
   *   WARN     → console + DB
   *   ERROR    → console + DB + notification queue
   *   CRITICAL → console + DB + notification queue
   */
  async record(
    event: LifecycleEvents,
    payload: Record<string, any>,
    level: LogLevel = LogLevel.INFO,
  ): Promise<void> {
    const tradeId = payload.id ?? null;
    const label = LEVEL_LABELS[level];

    // 1. Always log to console
    const consoleFn =
      level >= LogLevel.ERROR ? console.error : level >= LogLevel.WARN ? console.warn : console.log;
    consoleFn(`[${label}] ${event}`, payload);

    // 2. Write to Postgres (skip for DEBUG)
    if (this.pg && level >= LogLevel.INFO) {
      try {
        await this.pg.query(
          `INSERT INTO audit_logs (trade_id, event, level, payload, user_id) VALUES ($1, $2, $3, $4, $5)`,
          [tradeId, event, label, JSON.stringify(payload), this.userId],
        );
      } catch (err: any) {
        console.error("AuditLogService: DB write failed:", err?.message);
      }
    }

    // 3. Enqueue notification for ERROR and CRITICAL → admin channel (loggerChatId)
    if (this.notifQueue && level >= LogLevel.ERROR) {
      try {
        const emoji = LEVEL_EMOJI[level];
        const msg = this.formatTelegramMessage(emoji, label, event, payload);
        await this.notifQueue.add("audit-alert", {
          userId: this.userId ?? 0,
          text: msg,
          channel: "admin",
          traceId: payload.traceId ?? `audit-${Date.now()}`,
          enqueuedAt: new Date().toISOString(),
        });
      } catch {
        // Queue failure should never break the main flow
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Convenience methods                                                */
  /* ------------------------------------------------------------------ */

  async debug(event: LifecycleEvents, payload: Record<string, any>): Promise<void> {
    return this.record(event, payload, LogLevel.DEBUG);
  }

  async info(event: LifecycleEvents, payload: Record<string, any>): Promise<void> {
    return this.record(event, payload, LogLevel.INFO);
  }

  async warn(event: LifecycleEvents, payload: Record<string, any>): Promise<void> {
    return this.record(event, payload, LogLevel.WARN);
  }

  async error(event: LifecycleEvents, payload: Record<string, any>): Promise<void> {
    return this.record(event, payload, LogLevel.ERROR);
  }

  async critical(event: LifecycleEvents, payload: Record<string, any>): Promise<void> {
    return this.record(event, payload, LogLevel.CRITICAL);
  }

  /* ------------------------------------------------------------------ */
  /*  Trade notification (enqueued to trades channel → userChatId)       */
  /* ------------------------------------------------------------------ */

  /**
   * Enqueue a trade notification to the trades channel (userChatId).
   * Used for trade entry/exit/SL/target alerts.
   */
  async notify(text: string): Promise<void> {
    if (this.notifQueue) {
      try {
        await this.notifQueue.add("trade-alert", {
          userId: this.userId ?? 0,
          text,
          channel: "trades",
          traceId: `notify-${Date.now()}`,
          enqueuedAt: new Date().toISOString(),
        });
      } catch {
        // Queue failure should never break the main flow
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Internal                                                           */
  /* ------------------------------------------------------------------ */

  private formatTelegramMessage(
    emoji: string,
    label: string,
    event: string,
    payload: Record<string, any>,
  ): string {
    const lines: string[] = [];

    // Header
    lines.push(`${emoji} ${label}: ${event}`);

    // Trade ID
    if (payload.id) lines.push(`📋 Trade: #${payload.id}`);

    // Action / source (which code path triggered this)
    if (payload.action) lines.push(`📍 Action: ${payload.action}`);

    // Error message
    const errorMsg = payload.error || payload.message || payload.reason;
    if (errorMsg) lines.push(`💬 ${errorMsg}`);

    // HTTP details
    if (payload.httpStatus) lines.push(`🌐 HTTP ${payload.httpStatus}`);

    // Dhan-specific error code + message
    if (payload.dhanErrorCode) {
      const dhanLine = payload.dhanMessage
        ? `⚡ ${payload.dhanErrorCode}: ${payload.dhanMessage}`
        : `⚡ ${payload.dhanErrorCode}`;
      lines.push(dhanLine);
    } else if (payload.dhanMessage) {
      lines.push(`⚡ Dhan: ${payload.dhanMessage}`);
    }

    // Request URL (from interceptor-logged calls)
    if (payload.url) lines.push(`🔗 URL: ${payload.url}`);
    if (payload.method) lines.push(`📤 Method: ${payload.method}`);

    // Truncated request body (useful for debugging what was sent)
    if (payload.requestBody) {
      const body = this.truncateJson(payload.requestBody, 300);
      lines.push(`📦 Request: ${body}`);
    }

    // Truncated response body (useful for debugging what came back)
    if (payload.responseBody) {
      const body = this.truncateJson(payload.responseBody, 300);
      lines.push(`📥 Response: ${body}`);
    }

    return lines.join("\n");
  }

  /** Truncate a JSON-serializable value to maxLen characters for Telegram readability. */
  private truncateJson(value: any, maxLen: number): string {
    try {
      const str = typeof value === "string" ? value : JSON.stringify(value);
      return str.length > maxLen ? str.slice(0, maxLen) + "…" : str;
    } catch {
      return String(value).slice(0, maxLen);
    }
  }
}
