import { describe, expect, it } from "vitest";
import { telegramPollingRuntimeEnabled } from "./telegram-polling-policy.mjs";

describe("Telegram polling environment isolation", () => {
  it("keeps the production bot enabled by default", () => {
    expect(telegramPollingRuntimeEnabled({ NODE_ENV: "production", TG_BOT_TOKEN: "test-token" })).toBe(true);
  });
  it.each([undefined, "development", "test"])("does not let a %s worker silently take the configured bot", (nodeEnv) => {
    expect(telegramPollingRuntimeEnabled({ NODE_ENV: nodeEnv, TG_BOT_TOKEN: "test-token" })).toBe(false);
  });
  it("requires explicit opt-in for a local test bot and honors explicit disable in production", () => {
    expect(telegramPollingRuntimeEnabled({ TG_BOT_TOKEN: "test-token", TG_POLLING_ENABLED: "1" })).toBe(true);
    expect(telegramPollingRuntimeEnabled({ NODE_ENV: "production", TG_BOT_TOKEN: "test-token", TG_POLLING_ENABLED: "0" })).toBe(false);
    expect(telegramPollingRuntimeEnabled({ NODE_ENV: "production", TG_BOT_TOKEN: "test-token", TG_POLLING_ENABLED: "mistyped" })).toBe(false);
  });
  it.each(["autopilot", "media", "publication"])("does not enable polling in %s-only workers", (mode) => {
    expect(telegramPollingRuntimeEnabled({ TG_BOT_TOKEN: "test-token", TG_POLLING_ENABLED: "1", AURORA_WORKER_MODE: mode })).toBe(false);
  });
  it("requires a bot token even with explicit opt-in", () => {
    expect(telegramPollingRuntimeEnabled({ TG_POLLING_ENABLED: "1" })).toBe(false);
  });
});
