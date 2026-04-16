/*
  ConfigHandler: Multi-user /config command handler.

  /config           — Show all config values (global defaults + user overrides)
  /config <key> <value> — Set per-user override
  /config reset <key>   — Remove per-user override, revert to global default
  /config reset all     — Remove all per-user overrides
*/

import type { UserContext } from "../middleware/userResolver";
import { ConfigService } from "../../services/configService";
import type { Pool } from "pg";

export class ConfigHandler {
  constructor(private pool: Pool) {}

  /** /config — View all or update config */
  async handleConfig(ctx: UserContext): Promise<void> {
    const user = ctx.state.user;
    if (!user) return;

    if (user.status !== "ACTIVE") {
      await ctx.reply("❌ Complete setup first. Send /register");
      return;
    }

    const text = (ctx.message as any)?.text ?? "";
    const args = text.split(/\s+/).slice(1);

    // Create a per-user config instance
    const configSvc = new ConfigService(this.pool);
    await configSvc.loadForUser(user.id);

    // /config — show all config values
    if (args.length === 0) {
      const display = await this.getConfigDisplay(configSvc, user.id);
      await ctx.reply(display);
      return;
    }

    // /config reset <key> — remove a per-user override
    if (args[0] === "reset") {
      await this.handleReset(ctx, user.id, args.slice(1));
      return;
    }

    // /config <key> <value> — set per-user override
    if (args.length === 2) {
      const [key, value] = args;
      const result = await configSvc.setForUser(user.id, key, value);
      await ctx.reply(result.message);
      return;
    }

    await ctx.reply(
      "📖 Usage:\n" +
        "  /config — show current values\n" +
        "  /config <key> <value> — set a value\n" +
        "  /config reset <key> — revert to global default\n" +
        "  /config reset all — revert all overrides",
    );
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private async getConfigDisplay(configSvc: ConfigService, userId: number): Promise<string> {
    // Get user-specific overrides to mark which values are customized
    const userOverrides = await this.getUserOverrides(userId);
    return configSvc.getAllWithOverrides(userOverrides);
  }

  private async getUserOverrides(userId: number): Promise<Set<string>> {
    try {
      const res = await this.pool.query("SELECT key FROM user_config WHERE user_id = $1", [userId]);
      return new Set(res.rows.map((r: any) => r.key));
    } catch {
      return new Set();
    }
  }

  private async handleReset(ctx: UserContext, userId: number, args: string[]): Promise<void> {
    if (args.length === 0) {
      await ctx.reply("Usage: /config reset <key> or /config reset all");
      return;
    }

    const target = args[0].toLowerCase();

    if (target === "all") {
      try {
        const res = await this.pool.query("DELETE FROM user_config WHERE user_id = $1", [userId]);
        const count = res.rowCount ?? 0;
        await ctx.reply(
          count > 0
            ? `✅ Removed ${count} custom override(s). All values reverted to global defaults.`
            : "ℹ️ You have no custom overrides — already using global defaults.",
        );
      } catch (err: any) {
        await ctx.reply(`❌ Error: ${err?.message ?? "unknown"}`);
      }
      return;
    }

    // Reset specific key
    try {
      const res = await this.pool.query("DELETE FROM user_config WHERE user_id = $1 AND key = $2", [
        userId,
        target,
      ]);
      if ((res.rowCount ?? 0) > 0) {
        await ctx.reply(`✅ ${target} reverted to global default.`);
      } else {
        await ctx.reply(`ℹ️ No custom override found for "${target}".`);
      }
    } catch (err: any) {
      await ctx.reply(`❌ Error: ${err?.message ?? "unknown"}`);
    }
  }
}
