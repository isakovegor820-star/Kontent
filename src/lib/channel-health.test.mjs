import { describe, expect, it, vi } from "vitest";

import {
  classifyOAuthChannelFailure,
  classifyTelegramChannelFailure,
  classifyVkChannelFailure,
  safeChannelErrorCode,
  transitionChannelHealth,
} from "./channel-health.mjs";

describe("channel health classification", () => {
  it("distinguishes Telegram removal and lost permissions", () => {
    expect(classifyTelegramChannelFailure({ providerErrorCode: 403, reason: "bot was kicked" })).toEqual({
      status: "revoked",
      errorCode: "telegram_bot_removed",
    });
    expect(classifyTelegramChannelFailure({ providerErrorCode: 403, reason: "not enough rights" })).toEqual({
      status: "permission_lost",
      errorCode: "telegram_publish_permission_lost",
    });
    expect(classifyTelegramChannelFailure({ providerErrorCode: 400, reason: "Bad Request: chat not found" })).toEqual({
      status: "needs_reconnect",
      errorCode: "telegram_chat_not_found",
    });
  });

  it("distinguishes VK invalid token and permission denied", () => {
    expect(classifyVkChannelFailure({ outcome: "auth_failed", code: "vk_auth_5" })).toEqual({
      status: "revoked",
      errorCode: "vk_auth_5",
    });
    expect(classifyVkChannelFailure({ outcome: "auth_failed", code: "vk_permission_15" })).toEqual({
      status: "permission_lost",
      errorCode: "vk_permission_15",
    });
  });

  it("marks terminal OAuth refresh failure for reconnect and sanitizes codes", () => {
    expect(classifyOAuthChannelFailure({ outcome: "auth_failed", code: "oauth_refresh_failed" })).toEqual({
      status: "needs_reconnect",
      errorCode: "oauth_refresh_failed",
    });
    expect(safeChannelErrorCode("secret value with spaces")).toBe("provider_auth_failed");
  });

  it("uses explicit PostgreSQL parameter types and records a reversible health transition", async () => {
    const query = vi.fn(async (sql) => {
      if (sql === "begin" || sql === "commit") return { rows: [], rowCount: 0 };
      if (String(sql).includes("for update")) return { rows: [{ id: 21, user_id: 7, status: "active" }], rowCount: 1 };
      if (String(sql).includes("update channels")) {
        expect(sql).toContain("$2::text");
        expect(sql).toContain("$3::text");
        return { rows: [], rowCount: 1 };
      }
      if (String(sql).includes("insert into channel_events")) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    });
    const release = vi.fn();
    const db = { connect: vi.fn(async () => ({ query, release })) };
    await expect(transitionChannelHealth(db, {
      channelId: 21,
      status: "needs_reconnect",
      errorCode: "telegram_chat_not_found",
      action: "telegram_health_reconciliation",
    })).resolves.toEqual({
      channelId: 21,
      fromStatus: "active",
      status: "needs_reconnect",
      errorCode: "telegram_chat_not_found",
    });
    expect(release).toHaveBeenCalledOnce();
  });
});
