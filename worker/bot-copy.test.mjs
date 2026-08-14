import { describe, expect, it } from "vitest";

import {
  BOT_HELP_TEXT,
  COMPETITOR_MECHANIC_ACTION_LABEL,
  formatBotToday,
} from "./bot-copy.mjs";

describe("Telegram competitor action copy", () => {
  it("uses the platform-neutral action label", () => {
    expect(COMPETITOR_MECHANIC_ACTION_LABEL).toBe("Создать пост по механике");
    expect(COMPETITOR_MECHANIC_ACTION_LABEL).not.toContain("Сними это");
  });
});

describe("Telegram daily control summary", () => {
  it("names every consequential state instead of relying on emoji", () => {
    const message = formatBotToday({
      projectName: "Aurora Media",
      timezone: "Europe/Moscow",
      scheduledToday: 3,
      scheduledFuture: 8,
      published24h: 4,
      failed: 2,
      reconnect: 1,
      upcoming: [{ scheduledAt: "2026-08-15T07:00:00.000Z", network: "tg", channel: "Новости" }],
    });

    expect(message).toContain("Аврора сегодня");
    expect(message).toContain("3 публикации");
    expect(message).toContain("2 ошибки публикаций");
    expect(message).toContain("1 канал нужно переподключить");
    expect(message).toContain("10:00 — Telegram · Новости");
  });

  it("shows a clear next step when the day is empty", () => {
    const message = formatBotToday({ scheduledToday: 0, failed: 0, reconnect: 0, upcoming: [] });
    expect(message).toContain("работают без подтверждённых ошибок");
    expect(message).toContain("ничего не запланировано");
  });

  it("documents the new pocket-workflow commands", () => {
    expect(BOT_HELP_TEXT).toContain("/today");
    expect(BOT_HELP_TEXT).toContain("/create");
  });
});
