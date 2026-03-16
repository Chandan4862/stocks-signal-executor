/**
 * TelegramService: Telegram bot for commands + push notifications.
 *
 * Single Responsibility: outbound alerts & inbound command handling via Telegraf.
 *
 * Commands:
 *   /start      - Welcome message
 *   /status     - Health-check summary (includes token validity)
 *   /positions  - Active positions (stub)
 *   /pnl        - PnL summary (stub)
 *   /logs       - Recent audit logs (stub)
 *   /token <ACCESS_TOKEN> [YYYY-MM-DD] - Submit & validate a new Dhan access token
 *   /renew      - Renew the current access token for another 24h
 *   "Hello"     - Health-check echo → replies "World 🌍"
 *
 * Push notifications via `notify(text)` are sent to `defaultChatId`.
 */

import { Telegraf } from "telegraf";
import { TokenService, DhanProfile } from "./tokenService";
import { AuditLogService } from "./auditLogService";
import { LifecycleEvents } from "../enums/trade";

export class TelegramService {
  private bot: Telegraf;
  private launched = false;
  private tokenService?: TokenService;
  private audit?: AuditLogService;

  constructor(
    private botToken: string,
    private defaultChatId: string,
    private tradesChatId?: string,
  ) {
    this.bot = new Telegraf(this.botToken);
    this.registerHandlers();
  }

  /**
   * Inject TokenService for /token and /renew commands.
   * Called after boot when all services are initialized.
   */
  setTokenService(ts: TokenService): void {
    this.tokenService = ts;
  }

  /**
   * Inject AuditLogService for structured error logging.
   * Uses WARN level only — never ERROR/CRITICAL — to avoid
   * circular Telegram→audit→Telegram loops.
   */
  setAudit(audit: AuditLogService): void {
    this.audit = audit;
  }

  /* ------------------------------------------------------------------ */
  /*  Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Start the bot in long-polling mode.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async launch(): Promise<void> {
    if (this.launched) return;
    this.launched = true;

    // Launch in background (does not block)
    this.bot.launch().catch((err) => {
      this.logWarn("launch", "Bot launch error", err);
      this.launched = false;
    });

    this.logInfo("launch", "Bot launched (polling)");
  }

  /**
   * Graceful shutdown — stops long-polling.
   */
  async stop(signal = "SIGTERM"): Promise<void> {
    if (!this.launched) return;
    this.bot.stop(signal);
    this.launched = false;
    this.logInfo("stop", "Bot stopped");
  }

  /* ------------------------------------------------------------------ */
  /*  Outbound notifications                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Send a text message to the configured default chat.
   * Supports Markdown (MarkdownV2) for rich formatting.
   */
  async notify(text: string, parseMode?: "MarkdownV2" | "HTML"): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(
        this.defaultChatId,
        text,
        parseMode ? { parse_mode: parseMode } : undefined,
      );
    } catch (err: any) {
      // WARN only — never ERROR — to prevent recursive audit→notify loop
      this.logWarn("notify", "Send message failed", err);
    }
  }

  /**
   * Send a trade notification to the dedicated trades channel.
   * Falls back to the default channel if tradesChatId is not configured.
   */
  async notifyTrades(text: string): Promise<void> {
    const chatId = this.tradesChatId || this.defaultChatId;
    try {
      await this.bot.telegram.sendMessage(chatId, text);
    } catch (err: any) {
      this.logWarn("notifyTrades", "Send trade notification failed", err);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Command handlers (registered once in constructor)                  */
  /* ------------------------------------------------------------------ */

  private registerHandlers(): void {
    // /start — welcome
    this.bot.start((ctx) => {
      ctx.reply(
        "🤖 *Stocks Signal Executor* is online\\.\nType /status for a health check\\.",
        { parse_mode: "MarkdownV2" },
      );
    });

    // /status — quick health check (now includes token validity)
    this.bot.command("status", async (ctx) => {
      const uptime = process.uptime();
      const mins = Math.floor(uptime / 60);
      const secs = Math.floor(uptime % 60);

      let tokenInfo = "⚠️ TokenService not available";
      if (this.tokenService) {
        try {
          const token = await this.tokenService.getToken();
          if (token) {
            const profile = await this.tokenService.fetchProfile(token);
            if (profile) {
              tokenInfo = `✅ Token valid until: ${profile.tokenValidity}`;
            } else {
              tokenInfo = "❌ Token exists but validation failed";
            }
          } else {
            tokenInfo = "❌ No token available";
          }
        } catch (err: any) {
          this.logWarn("status", "Token check failed", err);
          tokenInfo = "⚠️ Token check failed";
        }
      }

      ctx.reply(
        `✅ Bot is running.\nUptime: ${mins}m ${secs}s\n\n🔑 Auth: ${tokenInfo}`,
      );
    });

    // /positions — stub for now
    this.bot.command("positions", (ctx) => {
      ctx.reply("📊 Positions: (coming soon)");
    });

    // /pnl — stub for now
    this.bot.command("pnl", (ctx) => {
      ctx.reply("💰 PnL: (coming soon)");
    });

    // /logs — stub for now
    this.bot.command("logs", (ctx) => {
      ctx.reply("📋 Recent logs: (coming soon)");
    });

    // /token <ACCESS_TOKEN> [YYYY-MM-DD] — submit & validate a Dhan access token
    this.bot.command("token", async (ctx) => {
      if (!this.tokenService) {
        ctx.reply("⚠️ TokenService not initialized yet. Try again later.");
        return;
      }

      const args = ctx.message.text.split(/\s+/).slice(1);
      const token = args[0];
      if (!token) {
        ctx.reply(
          "Usage: /token ACCESS_TOKEN [YYYY-MM-DD]\n\n" +
            "The token is your Dhan access token (from web.dhan.co).\n" +
            "Optionally specify the expiry date (e.g. 2026-03-03).",
        );
        return;
      }

      const maskedToken = token.slice(0, 6) + "***" + token.slice(-4);
      ctx.reply(`🔄 Validating token (${maskedToken})…`);

      // Parse optional expiry
      let expiresAt: Date | undefined;
      if (args[1]) {
        const parsed = new Date(args[1]);
        if (!isNaN(parsed.getTime())) {
          expiresAt = parsed;
        }
      }

      try {
        const stored = await this.tokenService.setToken(token, expiresAt);
        if (stored) {
          // Fetch profile for confirmation details
          const profile = await this.tokenService.fetchProfile(token);
          const validity = profile?.tokenValidity ?? "unknown";
          ctx.reply(
            `✅ Token validated and stored!\n` +
              `🔑 Valid until: ${validity}\n` +
              `👤 Client: ${profile?.dhanClientId ?? "unknown"}`,
          );
        } else {
          ctx.reply(
            "❌ Token validation failed. Please check:\n" +
              "• Is it a valid Dhan access token?\n" +
              "• Has it expired? (tokens are valid for ~24 hours)\n" +
              "• Generate a new one from web.dhan.co",
          );
        }
      } catch (err: any) {
        this.logWarn("/token", "Error storing token", err);
        ctx.reply(`❌ Error storing token: ${err?.message ?? "unknown"}`);
      }
    });

    // /renew — renew the current active token for another 24h
    this.bot.command("renew", async (ctx) => {
      if (!this.tokenService) {
        ctx.reply("⚠️ TokenService not initialized yet. Try again later.");
        return;
      }

      ctx.reply("🔄 Attempting to renew token…");

      try {
        const currentToken = await this.tokenService.getToken();
        if (!currentToken) {
          ctx.reply(
            "❌ No active token to renew. Submit one with /token first.",
          );
          return;
        }

        const newToken = await this.tokenService.renewToken(currentToken);
        if (newToken) {
          const profile = await this.tokenService.fetchProfile(newToken);
          ctx.reply(
            `✅ Token renewed!\n🔑 New validity: ${profile?.tokenValidity ?? "~24h from now"}`,
          );
        } else {
          ctx.reply(
            "❌ Renewal failed. The token may have already expired.\n" +
              "Generate a new one from web.dhan.co and submit with /token.",
          );
        }
      } catch (err: any) {
        this.logWarn("/renew", "Renewal error", err);
        ctx.reply(`❌ Renewal error: ${err?.message ?? "unknown"}`);
      }
    });

    // --- Health-check echo: "Hello" → "World 🌍" ---
    this.bot.hears(/^hello$/i, (ctx) => {
      ctx.reply("World 🌍");
    });

    // Catch-all for unrecognised text
    this.bot.on("text", (ctx) => {
      ctx.reply(
        "🤷 Unknown command. Try /start, /status, /positions, /pnl, /logs, /token, or /renew.",
      );
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Expose bot instance (for advanced use / testing)                   */
  /* ------------------------------------------------------------------ */

  /** Returns the underlying Telegraf instance (useful for testing). */
  getBot(): Telegraf {
    return this.bot;
  }

  /* ------------------------------------------------------------------ */
  /*  Internal logging helpers                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Log at WARN level (console + DB, never Telegram) to avoid circular loops.
   */
  private logWarn(action: string, message: string, err?: any): void {
    if (this.audit) {
      this.audit
        .warn(LifecycleEvents.ERROR_OCCURRED, {
          service: "TelegramService",
          action,
          error: message,
          message: err?.message ?? String(err ?? ""),
        })
        .catch(() => {});
    } else {
      console.warn(`TelegramService [${action}]:`, message, err?.message ?? "");
    }
  }

  private logInfo(action: string, message: string): void {
    if (this.audit) {
      this.audit
        .info(LifecycleEvents.DHAN_API_CALL, {
          service: "TelegramService",
          action,
          message,
        })
        .catch(() => {});
    } else {
      console.log(`TelegramService [${action}]:`, message);
    }
  }
}
