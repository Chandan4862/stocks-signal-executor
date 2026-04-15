/*
  UserResolver Middleware: Resolves Telegram chat ID → user record on every message.
  Attaches user to ctx.state.user for downstream handlers.
  Allows unregistered users to access /start and /register only.
*/

import type { Context, MiddlewareFn } from "telegraf";
import type { UserService } from "../../modules/user/userService";
import type { UserRow } from "../../modules/user/userRepository";

/** Extend Telegraf context with user state */
export interface UserContext extends Context {
  state: {
    user: UserRow | null;
  };
}

/** Commands that don't require an existing user */
const PUBLIC_COMMANDS = ["/start", "/register"];

export function createUserResolverMiddleware(userService: UserService): MiddlewareFn<UserContext> {
  return async (ctx, next) => {
    const chatId = String(ctx.chat?.id ?? "");
    if (!chatId) {
      return next();
    }

    // Resolve user from cache/DB
    const user = await userService.findByTelegramChatId(chatId);
    ctx.state = ctx.state || {};
    ctx.state.user = user;

    // Allow public commands for unregistered users
    const messageText = (ctx.message as any)?.text ?? "";
    const command = messageText.split(" ")[0]?.toLowerCase();

    if (!user && !PUBLIC_COMMANDS.includes(command)) {
      await ctx.reply(
        "👋 Welcome! You're not registered yet.\n" +
          "Send /start to begin setting up your trading account.",
      );
      return;
    }

    return next();
  };
}
