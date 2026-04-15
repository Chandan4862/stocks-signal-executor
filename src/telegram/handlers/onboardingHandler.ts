/*
  OnboardingHandler: Telegram command handlers for user registration and broker setup.
  
  Flow: /start → /register → setup_broker <client_id> → /setup_totp <secret> → /enable
*/

import type { UserContext } from "../middleware/userResolver";
import type { UserService } from "../../modules/user/userService";
import type { CredentialVault, BrokerCredentials } from "../../modules/auth/credentialVault";
import Redis from "ioredis";

export class OnboardingHandler {
  constructor(
    private userService: UserService,
    private vault: CredentialVault,
    private redis: Redis,
  ) {}

  /** /start — Welcome message */
  async handleStart(ctx: UserContext): Promise<void> {
    const user = ctx.state.user;

    if (user && user.status === "ACTIVE") {
      await ctx.reply(
        `👋 Welcome back, ${user.display_name || user.telegram_username || "trader"}!\n\n` +
          `Status: ${user.trading_enabled ? "🟢 Trading ENABLED" : "🔴 Trading DISABLED"}\n\n` +
          `Commands:\n` +
          `/status — Check token & trades\n` +
          `/enable — Start auto-trading\n` +
          `/disable — Pause trading\n` +
          `/positions — View open trades\n` +
          `/pnl — View realized P&L\n` +
          `/config — View/update settings`,
      );
      return;
    }

    await ctx.reply(
      `👋 Welcome to the Auto-Trading Bot!\n\n` +
        `I'll help you set up automated stock trading on NSE.\n\n` +
        `To get started, send /register`,
    );
  }

  /** /register — Create user account */
  async handleRegister(ctx: UserContext): Promise<void> {
    const chatId = String(ctx.chat?.id);
    const from = ctx.from;

    // Check if already registered
    let user = ctx.state.user;
    if (user) {
      if (user.status === "ACTIVE") {
        await ctx.reply("✅ You're already registered and set up!");
        return;
      }
      if (user.status === "ONBOARDING") {
        await this.promptBrokerSetup(ctx);
        return;
      }
    }

    // Create new user
    user = await this.userService.register({
      telegramChatId: chatId,
      telegramUsername: from?.username,
      displayName: from?.first_name
        ? `${from.first_name}${from.last_name ? " " + from.last_name : ""}`
        : undefined,
    });

    ctx.state.user = user;
    await this.promptBrokerSetup(ctx);
  }

  /** /setup_broker <client_id> — Store Dhan client ID */
  async handleSetupBroker(ctx: UserContext): Promise<void> {
    const user = ctx.state.user;
    if (!user) return;

    const text = (ctx.message as any)?.text ?? "";
    const parts = text.split(/\s+/);
    const clientId = parts[1];

    if (!clientId || clientId.length < 5) {
      await ctx.reply(
        "❌ Invalid client ID.\n\n" +
          "Usage: /setup_broker <your_dhan_client_id>\n" +
          "Example: /setup_broker 1100123456",
      );
      return;
    }

    await this.userService.setDhanClientId(user.id, clientId);

    await ctx.reply(
      `✅ Dhan Client ID saved: ${clientId}\n\n` +
        `Step 2/3: Choose your auth method:\n\n` +
        `Option A (recommended):\n` +
        `Send your TOTP secret for automatic token generation.\n` +
        `/setup_totp <pin> <totp_secret>\n\n` +
        `Option B (manual):\n` +
        `Paste an access token directly.\n` +
        `/token <your_access_token>`,
    );
  }

  /** /setup_totp <pin> <totp_secret> — Store encrypted TOTP credentials */
  async handleSetupTotp(ctx: UserContext): Promise<void> {
    const user = ctx.state.user;
    if (!user) return;

    const text = (ctx.message as any)?.text ?? "";
    const parts = text.split(/\s+/);

    if (parts.length < 3) {
      await ctx.reply(
        "❌ Usage: /setup_totp <pin> <totp_secret>\n\n" +
          "Your PIN is the login PIN for Dhan.\n" +
          "Your TOTP secret is the base32 string from your authenticator setup.",
      );
      return;
    }

    const pin = parts[1];
    const totpSecret = parts[2];

    // Delete the user's message immediately (contains sensitive data)
    try {
      await ctx.deleteMessage();
    } catch {
      // May fail if bot doesn't have delete permissions — not critical
    }

    // Encrypt and store credentials
    const credentials: BrokerCredentials = { pin, totpSecret };
    await this.userService.setDhanCredentials(user.id, credentials);

    // Mark as onboarded
    await this.userService.markOnboarded(user.id);

    await ctx.reply(
      `✅ TOTP credentials saved and encrypted!\n` +
        `⚠️ Your message was deleted for security.\n\n` +
        `Step 3/3: You're all set! 🎉\n\n` +
        `Trading is currently OFF.\n` +
        `Send /enable to start auto-trading.\n\n` +
        `Useful commands:\n` +
        `/enable — Start trading\n` +
        `/disable — Pause trading\n` +
        `/status — Check token & trades\n` +
        `/config — View/edit settings\n` +
        `/pnl — View P&L`,
    );
  }

  /** /token <access_token> — Manual token submission */
  async handleToken(ctx: UserContext): Promise<void> {
    const user = ctx.state.user;
    if (!user) return;

    const text = (ctx.message as any)?.text ?? "";
    const parts = text.split(/\s+/);
    const token = parts[1];

    if (!token || token.length < 20) {
      await ctx.reply("❌ Invalid token.\n\nUsage: /token <your_dhan_access_token>");
      return;
    }

    // Delete the message (contains token)
    try {
      await ctx.deleteMessage();
    } catch {}

    // Store token in Redis
    await this.redis.set(`token:${user.id}`, token, "EX", 86400); // 24h TTL

    // If user was onboarding, mark as active
    if (user.status === "ONBOARDING") {
      await this.userService.markOnboarded(user.id);
    }

    await ctx.reply(
      `✅ Token stored securely!\n` +
        `⚠️ Your message was deleted for security.\n` +
        `Token expires in ~24 hours.\n\n` +
        (user.dhan_credentials_enc
          ? `TOTP is configured — token will auto-renew.`
          : `⚠️ Without TOTP, you'll need to send /token again daily.`),
    );
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private async promptBrokerSetup(ctx: UserContext): Promise<void> {
    await ctx.reply(
      `📋 Step 1/3: Dhan Client ID\n\n` +
        `Open your Dhan app → Profile → Your client ID.\n` +
        `It looks like: 1100XXXXXX\n\n` +
        `Send: /setup_broker <your_client_id>`,
    );
  }
}
