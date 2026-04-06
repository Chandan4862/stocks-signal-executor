/*
 AuditLogService: Centralized event journal with level-based routing.

 Routing matrix:
   DEBUG    → console only
   INFO     → console + Postgres
   WARN     → console + Postgres
   ERROR    → console + Postgres + Telegram
   CRITICAL → console + Postgres + Telegram (🔴 prefix)
*/

import type { Client } from "pg";
import { LifecycleEvents, LogLevel } from "../enums/trade";

/** Telegram notifier interface — avoids circular dependency on TelegramService */
export interface TelegramNotifier {
  notify(text: string, parseMode?: "MarkdownV2" | "HTML"): Promise<void>;
  notifyTrades(text: string): Promise<void>;
}

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
  private pg: Client | null;
  private telegram: TelegramNotifier | null;

  constructor(pg?: Client | null, telegram?: TelegramNotifier | null) {
    this.pg = pg ?? null;
    this.telegram = telegram ?? null;
  }

  /**
   * Set or update the Telegram notifier after construction.
   * Useful when TelegramService is initialized later in the boot sequence.
   */
  setTelegram(telegram: TelegramNotifier): void {
    this.telegram = telegram;
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
   *   ERROR    → console + DB + Telegram
   *   CRITICAL → console + DB + Telegram
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
      level >= LogLevel.ERROR
        ? console.error
        : level >= LogLevel.WARN
          ? console.warn
          : console.log;
    consoleFn(`[${label}] ${event}`, payload);

    // 2. Write to Postgres (skip for DEBUG)
    if (this.pg && level >= LogLevel.INFO) {
      try {
        await this.pg.query(
          `INSERT INTO audit_logs (trade_id, event, level, payload) VALUES ($1, $2, $3, $4)`,
          [tradeId, event, label, JSON.stringify(payload)],
        );
      } catch (err: any) {
        console.error("AuditLogService: DB write failed:", err?.message);
      }
    }

    // 3. Send to Telegram for ERROR and CRITICAL
    if (this.telegram && level >= LogLevel.ERROR) {
      try {
        const emoji = LEVEL_EMOJI[level];
        const msg = this.formatTelegramMessage(emoji, label, event, payload);
        await this.telegram.notify(msg);
      } catch {
        // Telegram failure should never break the main flow
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Convenience methods                                                */
  /* ------------------------------------------------------------------ */

  async debug(
    event: LifecycleEvents,
    payload: Record<string, any>,
  ): Promise<void> {
    return this.record(event, payload, LogLevel.DEBUG);
  }

  async info(
    event: LifecycleEvents,
    payload: Record<string, any>,
  ): Promise<void> {
    return this.record(event, payload, LogLevel.INFO);
  }

  async warn(
    event: LifecycleEvents,
    payload: Record<string, any>,
  ): Promise<void> {
    return this.record(event, payload, LogLevel.WARN);
  }

  async error(
    event: LifecycleEvents,
    payload: Record<string, any>,
  ): Promise<void> {
    return this.record(event, payload, LogLevel.ERROR);
  }

  async critical(
    event: LifecycleEvents,
    payload: Record<string, any>,
  ): Promise<void> {
    return this.record(event, payload, LogLevel.CRITICAL);
  }

  /* ------------------------------------------------------------------ */
  /*  Direct Telegram notification (for trade alerts, not errors)         */
  /* ------------------------------------------------------------------ */

  /**
   * Send a trade notification to the dedicated Trades channel.
   * Uses notifyTrades() → TELEGRAM_TRADES_CHAT_ID (falls back to default).
   */
  async notify(text: string): Promise<void> {
    if (this.telegram) {
      try {
        await this.telegram.notifyTrades(text);
      } catch {
        // Telegram failure should never break the main flow
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
