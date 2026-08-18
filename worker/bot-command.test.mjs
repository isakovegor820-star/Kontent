import { describe, expect, it } from "vitest";

import { parseTelegramBotCommand } from "./bot-command.mjs";

describe("Telegram bot command parser", () => {
  it("parses exact commands, arguments and bot mentions", () => {
    expect(parseTelegramBotCommand("/status", "aurora_bot")).toEqual({
      command: "status",
      target: null,
      args: "",
    });
    expect(parseTelegramBotCommand("/start@Aurora_Bot abc123", "@aurora_bot")).toEqual({
      command: "start",
      target: "aurora_bot",
      args: "abc123",
    });
  });

  it("does not turn a command prefix into a different command", () => {
    expect(parseTelegramBotCommand("/status-report", "aurora_bot")).toBeNull();
    expect(parseTelegramBotCommand("/status/report", "aurora_bot")).toBeNull();
    expect(parseTelegramBotCommand("text /status", "aurora_bot")).toBeNull();
  });

  it("ignores commands addressed to another bot", () => {
    expect(parseTelegramBotCommand("/status@other_bot", "aurora_bot")).toBeNull();
  });
});
