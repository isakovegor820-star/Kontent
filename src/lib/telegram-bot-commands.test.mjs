import { describe, expect, it } from "vitest";

import { TELEGRAM_BOT_COMMANDS, telegramBotCommandsReady } from "./telegram-bot-commands.mjs";

describe("Telegram bot commands", () => {
  it("keeps the native menu complete and detects drift", () => {
    expect(telegramBotCommandsReady(TELEGRAM_BOT_COMMANDS)).toBe(true);
    expect(telegramBotCommandsReady(TELEGRAM_BOT_COMMANDS.slice(0, -1))).toBe(false);
    expect(new Set(TELEGRAM_BOT_COMMANDS.map((item) => item.command)).size).toBe(TELEGRAM_BOT_COMMANDS.length);
  });
});
