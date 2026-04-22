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
 * Push notifications via `notify(text)` are sent to `loggerChatId`.
 */

import { Telegraf } from "telegraf";
import { TokenService, DhanProfile } from "./tokenService";
import { AuditLogService } from "./auditLogService";
import { ConfigService } from "./configService";
import { LifecycleEvents } from "../enums/trade";
import type { Scheduler } from "./scheduler";
import type { UserResolverMiddleware, UserContext } from "../telegram/middleware/userResolver";
import type { OnboardingHandler } from "../telegram/handlers/onboardingHandler";
import type { TradingHandler } from "../telegram/handlers/tradingHandler";
import type { ConfigHandler } from "../telegram/handlers/configHandler";

export class TelegramService {
  private bot: Telegraf;
  private launched = false;
  private tokenService?: TokenService;
  private audit?: AuditLogService;
  private scheduler?: Scheduler;
  private configService?: ConfigService;

  constructor(
    private botToken: string,
    private loggerChatId: string,
    private userChatId?: string,
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

  /**
   * Inject Scheduler for /trade command.
   */
  setScheduler(scheduler: Scheduler): void {
    this.scheduler = scheduler;
  }

  /**
   * Inject ConfigService for /config command.
   */
  setConfigService(configSvc: ConfigService): void {
    this.configService = configSvc;
  }

  /**
   * Inject multi-user handlers (user resolver + onboarding + trading).
   * Must be called before launch() to register commands.
   */
  setMultiUserHandlers(
    userResolver: UserResolverMiddleware,
    onboarding: OnboardingHandler,
    trading: TradingHandler,
    config: ConfigHandler,
  ): void {
    this.registerMultiUserHandlers(userResolver, onboarding, trading, config);
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

    const MAX_RETRIES = 5;
    const BASE_DELAY_MS = 5_000;

    const attemptLaunch = async (attempt: number): Promise<void> => {
      try {
        await this.bot.launch();
        this.logInfo("launch", "Bot launched (polling)");
      } catch (err: any) {
        const delay = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), 60_000);
        this.logWarn(
          "launch",
          `Bot launch failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay / 1000}s`,
          err,
        );

        if (attempt >= MAX_RETRIES) {
          this.logWarn("launch", "Bot launch exhausted all retries — giving up", err);
          this.launched = false;
          return;
        }

        await new Promise((r) => setTimeout(r, delay));
        return attemptLaunch(attempt + 1);
      }
    };

    // Launch in background (does not block app startup)
    attemptLaunch(1).catch(() => {
      this.launched = false;
    });
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
        this.loggerChatId,
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
   * Falls back to the default channel if userChatId is not configured.
   */
  async notifyTrades(text: string): Promise<void> {
    const chatId = this.userChatId || this.loggerChatId;
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
    // Auth middleware — silently drop messages from unauthorized chats
    this.bot.use((ctx, next) => {
      if (!this.isAuthorized(ctx)) return;
      return next();
    });

    // /start — welcome
    this.bot.start((ctx) => {
      ctx.reply("🤖 *Stocks Signal Executor* is online\\.\nType /status for a health check\\.", {
        parse_mode: "MarkdownV2",
      });
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

      ctx.reply(`✅ Bot is running.\nUptime: ${mins}m ${secs}s\n\n🔑 Auth: ${tokenInfo}`);
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
          ctx.reply("❌ No active token to renew. Submit one with /token first.");
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

    // /trade — manually trigger trade scan (Phases 2+4)
    this.bot.command("trade", async (ctx) => {
      if (!this.scheduler) {
        ctx.reply("⚠️ Scheduler not initialized yet. Try again later.");
        return;
      }

      ctx.reply("🔄 Running trade scan (Phases 2+4)…");

      try {
        const result = await this.scheduler.runTradeScan();
        ctx.reply(result);
      } catch (err: any) {
        this.logWarn("/trade", "Trade scan error", err);
        ctx.reply(`❌ Trade scan error: ${err?.message ?? "unknown"}`);
      }
    });

    // /monitor — manually trigger monitor tick (Phases 3+5)
    this.bot.command("monitor", async (ctx) => {
      if (!this.scheduler) {
        ctx.reply("⚠️ Scheduler not initialized yet. Try again later.");
        return;
      }

      ctx.reply("🔄 Running monitor tick (Phases 3+5)…");

      try {
        const result = await this.scheduler.runMonitor();
        ctx.reply(result);
      } catch (err: any) {
        this.logWarn("/monitor", "Monitor error", err);
        ctx.reply(`❌ Monitor error: ${err?.message ?? "unknown"}`);
      }
    });

    // /reconcile — manually trigger position reconciliation (Phase 6)
    this.bot.command("reconcile", async (ctx) => {
      if (!this.scheduler) {
        ctx.reply("⚠️ Scheduler not initialized yet. Try again later.");
        return;
      }

      ctx.reply("🔄 Running reconciliation (Phase 6)…");

      try {
        const result = await this.scheduler.runReconciliation();
        ctx.reply(result);
      } catch (err: any) {
        this.logWarn("/reconcile", "Reconciliation error", err);
        ctx.reply(`❌ Reconciliation error: ${err?.message ?? "unknown"}`);
      }
    });

    // /closedtrades — manually trigger closed trades scan (analyst-closed signals)
    this.bot.command("closedtrades", async (ctx) => {
      if (!this.scheduler) {
        ctx.reply("⚠️ Scheduler not initialized yet. Try again later.");
        return;
      }

      ctx.reply("🔄 Running closed trades scan…");

      try {
        const result = await this.scheduler.runClosedTradesScan();
        ctx.reply(result);
      } catch (err: any) {
        this.logWarn("/closedtrades", "Closed trades scan error", err);
        ctx.reply(`❌ Closed trades scan error: ${err?.message ?? "unknown"}`);
      }
    });

    // /config — handled by multi-user ConfigHandler (registered in registerMultiUserHandlers)

    // Silently ignore all unrecognised messages — no reply to unauthorized users
  }

  /* ------------------------------------------------------------------ */
  /*  Multi-user command handlers (registered via setMultiUserHandlers)   */
  /* ------------------------------------------------------------------ */

  private registerMultiUserHandlers(
    userResolver: UserResolverMiddleware,
    onboarding: OnboardingHandler,
    trading: TradingHandler,
    config: ConfigHandler,
  ): void {
    // User resolver middleware — attaches user to ctx.state for all subsequent handlers
    this.bot.use(userResolver.middleware() as any);

    // Onboarding commands
    this.bot.command("register", (ctx) => onboarding.handleRegister(ctx as unknown as UserContext));
    this.bot.command("setup_broker", (ctx) =>
      onboarding.handleSetupBroker(ctx as unknown as UserContext),
    );
    this.bot.command("setup_totp", (ctx) =>
      onboarding.handleSetupTotp(ctx as unknown as UserContext),
    );

    // Trading commands (multi-user)
    this.bot.command("enable", (ctx) => trading.handleEnable(ctx as unknown as UserContext));
    this.bot.command("disable", (ctx) => trading.handleDisable(ctx as unknown as UserContext));
    this.bot.command("status", (ctx) => trading.handleStatus(ctx as unknown as UserContext));
    this.bot.command("monitor", (ctx) =>
      trading.handleManualMonitor(ctx as unknown as UserContext),
    );

    // Onboarding: manual token submission
    this.bot.command("token", (ctx) => onboarding.handleToken(ctx as unknown as UserContext));

    // Config command (multi-user)
    this.bot.command("config", (ctx) => config.handleConfig(ctx as unknown as UserContext));
  }

  /* ------------------------------------------------------------------ */
  /*  Authorization                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Only accept commands from the configured default chat (group/private).
   * Silently ignores all other chats — bot never reveals its capabilities
   * to unauthorized users.
   */
  private isAuthorized(ctx: any): boolean {
    return String(ctx.chat?.id) === this.userChatId;
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
