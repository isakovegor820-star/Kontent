import { describe, expect, it } from "vitest";

import {
  telegramPollingGuardConfiguration,
  telegramPollingGuardMatches,
  telegramPollingGuardPendingCount,
} from "./telegram-polling-guard.mjs";

describe("Telegram polling guard", () => {
  it("builds a deterministic secret-free Telegram queue gate", () => {
    const first = telegramPollingGuardConfiguration("123456:secret-token");
    const replay = telegramPollingGuardConfiguration("123456:secret-token");
    const other = telegramPollingGuardConfiguration("123456:other-token");

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      max_connections: 1,
      drop_pending_updates: false,
      allowed_updates: [
        "message", "channel_post", "edited_channel_post", "message_reaction_count",
        "callback_query", "my_chat_member", "business_message",
      ],
    });
    expect(first.url).toMatch(/^https:\/\/api\.telegram\.org\/aurora-polling-guard-[a-f0-9]{64}$/u);
    expect(first.secret_token).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(first)).not.toContain("secret-token");
    expect(other.url).not.toBe(first.url);
  });

  it("recognizes only its own gate and safely parses the pending count", () => {
    const token = "123456:secret-token";
    const guard = telegramPollingGuardConfiguration(token);

    expect(telegramPollingGuardMatches({ url: guard.url }, token)).toBe(true);
    expect(telegramPollingGuardMatches({ url: "https://example.com/hook" }, token)).toBe(false);
    expect(telegramPollingGuardMatches(null, token)).toBe(false);
    expect(telegramPollingGuardPendingCount({ pending_update_count: 3 })).toBe(3);
    expect(telegramPollingGuardPendingCount({ pending_update_count: -1 })).toBe(0);
    expect(telegramPollingGuardPendingCount({ pending_update_count: "bad" })).toBe(0);
  });

  it("rejects an empty token", () => {
    expect(() => telegramPollingGuardConfiguration(" ")).toThrow(TypeError);
  });
});
