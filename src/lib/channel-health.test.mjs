import { describe, expect, it } from "vitest";

import {
  classifyOAuthChannelFailure,
  classifyTelegramChannelFailure,
  classifyVkChannelFailure,
  safeChannelErrorCode,
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
});
