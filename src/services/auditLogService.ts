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
  /*  Internal                                                           */
  /* ------------------------------------------------------------------ */

  private formatTelegramMessage(
    emoji: string,
    label: string,
    event: string,
    payload: Record<string, any>,
  ): string {
    const tradeId = payload.id ? `Trade #${payload.id}` : "";
    const errorMsg = payload.error || payload.message || payload.reason || "";
    const lines = [`${emoji} ${label}: ${event}`, tradeId, errorMsg].filter(
      Boolean,
    );
    return lines.join("\n");
  }
}
