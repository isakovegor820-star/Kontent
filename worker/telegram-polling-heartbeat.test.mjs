import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  TELEGRAM_POLLING_HEARTBEAT_KEY,
  TELEGRAM_POLLING_HEARTBEAT_TTL_SECONDS,
  parseTelegramPollingHeartbeat,
  telegramPollingEnabled,
  telegramPollingHeartbeatWrite,
} from "./telegram-polling-heartbeat.mjs";

const NOW = new Date("2026-08-18T08:00:00.000Z").getTime();

describe("telegram polling heartbeat", () => {
  it("is enabled only for a full polling runtime with a token", () => {
    expect(telegramPollingEnabled({ mode: "full", token: "token" })).toBe(true);
    expect(telegramPollingEnabled({ mode: "", token: "token" })).toBe(true);
    expect(telegramPollingEnabled({ mode: "publication", token: "token" })).toBe(false);
    expect(telegramPollingEnabled({ mode: "media", token: "token" })).toBe(false);
    expect(telegramPollingEnabled({ mode: "full", token: "" })).toBe(false);
  });

  it("writes a short-lived role-specific proof only when polling is enabled", () => {
    expect(telegramPollingHeartbeatWrite({ mode: "publication", token: "token" }, NOW)).toBeNull();
    const write = telegramPollingHeartbeatWrite({ mode: "full", token: "token" }, NOW);
    expect(write).toMatchObject({
      key: TELEGRAM_POLLING_HEARTBEAT_KEY,
      ttlSeconds: TELEGRAM_POLLING_HEARTBEAT_TTL_SECONDS,
    });
    expect(JSON.parse(write.value)).toEqual({
      version: 1,
      role: "telegram_polling",
      state: "up",
      at: "2026-08-18T08:00:00.000Z",
    });
  });

  it("reports a fresh conflict without mistaking it for a healthy poller", () => {
    const write = telegramPollingHeartbeatWrite({
      mode: "full",
      token: "token",
      state: "conflict",
    }, NOW);
    expect(parseTelegramPollingHeartbeat(write.value, { nowMs: NOW })).toMatchObject({
      state: "conflict",
    });
  });

  it("rejects stale, malformed and wrong-role payloads", () => {
    const fresh = JSON.stringify({
      version: 1,
      role: "telegram_polling",
      state: "up",
      at: "2026-08-18T08:00:00.000Z",
    });
    expect(parseTelegramPollingHeartbeat(fresh, { nowMs: NOW + 74_000 })).toBeTruthy();
    expect(parseTelegramPollingHeartbeat(fresh, { nowMs: NOW + 75_000 })).toBeNull();
    expect(parseTelegramPollingHeartbeat(JSON.stringify({
      version: 1,
      role: "publication",
      state: "up",
      at: "2026-08-18T08:00:00.000Z",
    }), { nowMs: NOW })).toBeNull();
    expect(parseTelegramPollingHeartbeat("not-json", { nowMs: NOW })).toBeNull();
  });

  it("is refreshed only while the fast Telegram queue is owned", () => {
    const source = readFileSync(new URL("../worker.mjs", import.meta.url), "utf8");
    const polling = source.slice(
      source.indexOf("async function pollUpdates()"),
      source.indexOf("function parseMonthlyCampaignRegenerationJson"),
    );
    const opening = source.slice(
      source.indexOf("async function openTelegramPollingQueue"),
      source.indexOf("async function botProject"),
    );
    expect(polling).toContain("openTelegramPollingQueue()");
    expect(polling.indexOf("ensureTelegramPollingLease()")).toBeLessThan(
      polling.indexOf("openTelegramPollingQueue()"),
    );
    expect(polling).toContain('await refreshTelegramPollingHeartbeat("conflict")');
    expect(polling.indexOf("await refreshTelegramPollingHeartbeat();")).toBeLessThan(
      polling.indexOf('"getUpdates"'),
    );
    expect(polling).toContain("{ offset, timeout: 25, limit: 100 }");
    expect(opening.indexOf("enableTelegramPollingGuard()")).toBeLessThan(
      opening.indexOf('tg("deleteWebhook"'),
    );
  });
});
