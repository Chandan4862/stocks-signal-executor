/**
 * TelegramService: Telegram bot for commands + push notifications.
 *
 * Single Responsibility: outbound alerts & inbound command handling via Telegraf.
 *
 * All commands are registered via setMultiUserHandlers() and go through
 * the userResolver middleware for multi-tenant support.
 *
 * Push notifications via `notify(text)` are sent to `loggerChatId`.
 */

import { Telegraf } from "telegraf";
import { AuditLogService } from "./auditLogService";
import { LifecycleEvents } from "../enums/trade";
import type { UserResolverMiddleware, UserContext } from "../telegram/middleware/userResolver";
import type { OnboardingHandler } from "../telegram/handlers/onboardingHandler";
import type { TradingHandler } from "../telegram/handlers/tradingHandler";
import type { ConfigHandler } from "../telegram/handlers/configHandler";

export class TelegramService {
  private bot: Telegraf;
  private launched = false;
  private audit?: AuditLogService;

  constructor(
    private botToken: string,
    private loggerChatId: string,
  ) {
    this.bot = new Telegraf(this.botToken);
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
        // Race bot.launch() against a timeout to prevent silent hangs
        // (e.g. 409 Conflict when a previous polling session is still active)
        (this.bot.launch({ dropPendingUpdates: true }),
          this.logInfo("launch", "Bot launched (polling)"));
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
   * Send a notification to a specific chat (e.g. per-user trade alerts).
   */
  async notifyChat(chatId: string, text: string, parseMode?: "MarkdownV2" | "HTML"): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(
        chatId,
        text,
        parseMode ? { parse_mode: parseMode } : undefined,
      );
    } catch (err: any) {
      this.logWarn("notifyChat", "Send message failed", err);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Command handlers (registered via setMultiUserHandlers)              */
  /* ------------------------------------------------------------------ */

  private registerMultiUserHandlers(
    userResolver: UserResolverMiddleware,
    onboarding: OnboardingHandler,
    trading: TradingHandler,
    config: ConfigHandler,
  ): void {
    // User resolver middleware — attaches user to ctx.state for all subsequent handlers
    this.bot.use(userResolver.middleware() as any);

    // /start — contextual welcome (shows setup instructions or command menu)
    this.bot.start((ctx) => onboarding.handleStart(ctx as unknown as UserContext));

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
    this.bot.command("trade", (ctx) => trading.handleManualTrade(ctx as unknown as UserContext));
    this.bot.command("monitor", (ctx) =>
      trading.handleManualMonitor(ctx as unknown as UserContext),
    );
    this.bot.command("reconcile", (ctx) =>
      trading.handleManualReconcile(ctx as unknown as UserContext),
    );
    this.bot.command("closedtrades", (ctx) =>
      trading.handleManualClosedTrades(ctx as unknown as UserContext),
    );

    // Config command (multi-user)
    this.bot.command("config", (ctx) => config.handleConfig(ctx as unknown as UserContext));
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
