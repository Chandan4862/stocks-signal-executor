/*
 TelegramService: Commands + notifications (Phase 1: stub).
*/

export class TelegramService {
  constructor(
    private botToken: string,
    private defaultChatId: string,
  ) {}

  async notify(text: string): Promise<void> {
    // TODO (Phase 2): integrate node-telegram-bot-api or raw HTTPS
    console.log("TELEGRAM", text);
  }

  // Commands:
  // /positions, /pnl, /status, /logs
  async handleCommand(cmd: string): Promise<string> {
    switch (cmd) {
      case "/positions":
        return "Positions: (stub)";
      case "/pnl":
        return "PnL: (stub)";
      case "/status":
        return "Status: OK (stub)";
      case "/logs":
        return "Recent logs: (stub)";
      default:
        // Accept broker token via: /token ACCESS_TOKEN [YYYY-MM-DD]
        if (cmd.startsWith("/token ")) {
          const parts = cmd.split(/\s+/);
          const token = parts[1];
          const expires = parts[2] ? new Date(parts[2]) : undefined;
          if (!token) return "Usage: /token ACCESS_TOKEN [YYYY-MM-DD]";
          // TODO (Phase 2): validate token with Dhan ping and store via TokenService
          console.log("TOKEN-SUBMIT", {
            tokenMasked: token.slice(0, 4) + "***",
            expires,
          });
          return "Token received. Validating & storing (stub).";
        }
        return "Unknown command";
    }
  }
}
