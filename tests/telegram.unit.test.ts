import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TelegramService } from "../src/services/telegramService";

/*
  We test TelegramService by exercising its Telegraf handlers via the
  built-in `bot.handleUpdate` method, which processes a raw Telegram
  Update object without an actual network connection.

  We spy on `bot.telegram.callApi` — the single low-level method all
  Telegram API calls flow through — to intercept and assert outbound
  messages without hitting the real Telegram API.
*/

const BOT_TOKEN = "123456:ABC-DEF"; // fake but well-formed
const CHAT_ID = "99999";

/** Fake bot info to avoid Telegraf calling getMe over the network. */
const FAKE_BOT_INFO = {
  id: 123456,
  is_bot: true as const,
  first_name: "TestBot",
  username: "test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};

/** Build a minimal Telegram Update object for a text message. */
function makeTextUpdate(text: string, updateId = 1) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: 1, is_bot: false, first_name: "Test" },
      chat: { id: Number(CHAT_ID), type: "private" as const },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

describe("TelegramService", () => {
  let svc: TelegramService;
  let callApiSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    svc = new TelegramService(BOT_TOKEN, CHAT_ID);
    // Inject fake botInfo so handleUpdate skips the real getMe HTTP call
    svc.getBot().botInfo = FAKE_BOT_INFO;
    // Intercept ALL Telegram API calls at the transport level
    callApiSpy = vi
      .spyOn(svc.getBot().telegram, "callApi" as any)
      .mockResolvedValue({ message_id: 1 });
  });

  afterEach(async () => {
    await svc.stop("SIGTERM");
    vi.restoreAllMocks();
  });

  /** Extract the text from the first sendMessage callApi invocation. */
  function findSendMessageText(): string | undefined {
    const call = callApiSpy.mock.calls.find((c) => c[0] === "sendMessage");
    return call ? (call[1] as any)?.text : undefined;
  }

  /* ------------------------------------------------------------------ */
  /*  notify()                                                           */
  /* ------------------------------------------------------------------ */

  it("notify() calls sendMessage with the default chat id", async () => {
    await svc.notify("Hello from tests");

    const call = callApiSpy.mock.calls.find((c) => c[0] === "sendMessage");
    expect(call).toBeDefined();
    expect((call![1] as any).chat_id).toBe(CHAT_ID);
    expect((call![1] as any).text).toBe("Hello from tests");
  });

  it("notify() swallows errors and logs to console", async () => {
    callApiSpy.mockRejectedValue(new Error("network fail"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Should not throw
    await svc.notify("fail message");

    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  /* ------------------------------------------------------------------ */
  /*  "Hello" → "World 🌍" health-check                                 */
  /* ------------------------------------------------------------------ */

  it('responds "World 🌍" when user sends "Hello"', async () => {
    await svc.getBot().handleUpdate(makeTextUpdate("Hello"));

    const text = findSendMessageText();
    expect(text).toBe("World 🌍");
  });

  it('responds "World 🌍" case-insensitively ("hello")', async () => {
    await svc.getBot().handleUpdate(makeTextUpdate("hello"));

    const text = findSendMessageText();
    expect(text).toBe("World 🌍");
  });

  /* ------------------------------------------------------------------ */
  /*  /status command                                                    */
  /* ------------------------------------------------------------------ */

  it("/status returns uptime information", async () => {
    await svc.getBot().handleUpdate(makeTextUpdate("/status"));

    const text = findSendMessageText();
    expect(text).toBeDefined();
    expect(text).toContain("Bot is running");
  });

  /* ------------------------------------------------------------------ */
  /*  Unknown text → help message                                        */
  /* ------------------------------------------------------------------ */

  it("replies with help on unknown text", async () => {
    await svc.getBot().handleUpdate(makeTextUpdate("random gibberish"));

    const text = findSendMessageText();
    expect(text).toBeDefined();
    expect(text).toContain("Unknown command");
  });
});
});
