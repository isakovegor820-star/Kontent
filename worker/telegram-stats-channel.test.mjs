import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { resolveTelegramStatsHandle } from "./telegram-stats-channel.mjs";

const channel = {
  id: 41,
  project_id: 7,
  tg_chat_id: "-1001234567890",
  handle: null,
};

describe("Telegram stats channel handle", () => {
  it("refreshes the handle before the public-feed collection in the worker", () => {
    const worker = readFileSync(new URL("../worker.mjs", import.meta.url), "utf8");
    const collection = worker.slice(
      worker.indexOf("async function collectStats(projectId)"),
      worker.indexOf("async function collectVkStats(projectId)"),
    );

    expect(collection.indexOf("resolveTelegramStatsHandle(")).toBeGreaterThanOrEqual(0);
    expect(collection.indexOf("resolveTelegramStatsHandle(")).toBeLessThan(
      collection.indexOf("fetchPublicStats(statsHandle)"),
    );
  });

  it("recovers a missing public username before collecting stats", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    const getChat = vi.fn().mockResolvedValue({
      ok: true,
      result: { id: -1001234567890, username: "TechPravoAI" },
    });

    await expect(resolveTelegramStatsHandle(db, channel, getChat)).resolves.toEqual({
      handle: "TechPravoAI",
      refreshed: true,
      source: "telegram",
    });
    expect(getChat).toHaveBeenCalledWith("-1001234567890");
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("set handle = $1"),
      ["TechPravoAI", 41, 7],
    );
  });

  it("updates a stale username after the channel is renamed", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    const getChat = vi.fn().mockResolvedValue({
      ok: true,
      result: { username: "TechPravoAI" },
    });

    const result = await resolveTelegramStatsHandle(
      db,
      { ...channel, handle: "old_tech_pravo" },
      getChat,
    );

    expect(result).toMatchObject({ handle: "TechPravoAI", refreshed: true });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("keeps the saved handle when Telegram is temporarily unavailable", async () => {
    const db = { query: vi.fn() };
    const getChat = vi.fn().mockRejectedValue(new Error("timeout"));

    await expect(resolveTelegramStatsHandle(
      db,
      { ...channel, handle: "@TechPravoAI" },
      getChat,
    )).resolves.toEqual({
      handle: "TechPravoAI",
      refreshed: false,
      source: "saved",
    });
    expect(db.query).not.toHaveBeenCalled();
  });
});
