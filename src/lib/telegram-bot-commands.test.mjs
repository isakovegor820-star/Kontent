import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { TELEGRAM_BOT_COMMANDS, telegramBotCommandsReady } from "./telegram-bot-commands.mjs";

describe("Telegram bot commands", () => {
  it("keeps the native menu complete and detects drift", () => {
    expect(telegramBotCommandsReady(TELEGRAM_BOT_COMMANDS)).toBe(true);
    expect(telegramBotCommandsReady(TELEGRAM_BOT_COMMANDS.slice(0, -1))).toBe(false);
    expect(new Set(TELEGRAM_BOT_COMMANDS.map((item) => item.command)).size).toBe(TELEGRAM_BOT_COMMANDS.length);
    expect(TELEGRAM_BOT_COMMANDS.map((item) => item.command)).not.toContain("plan");
    expect(TELEGRAM_BOT_COMMANDS.map((item) => item.command)).not.toContain("trends");
  });

  it("keeps hidden Telegram actions behind the same explicit preview flag", () => {
    const worker = readFileSync(new URL("../../worker.mjs", import.meta.url), "utf8");
    expect(worker).toContain('process.env.NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES === "1"');
    expect(worker).toContain('new Set(["clients", "plan", "trends"]).has(action)');
  });
});
