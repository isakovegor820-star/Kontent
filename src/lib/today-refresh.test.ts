import { describe, expect, it, vi } from "vitest";

import { refreshTodaySources } from "./today-refresh";

function database() {
  const attempts: Array<[string, string]> = [];
  return {
    attempts,
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("user_project_preferences")) {
        return { rows: [{ project_id: "7", user_id: "9", role: "owner", version: "1" }] };
      }
      if (sql.includes("select id from channels")) return { rows: [{ id: "11" }] };
      if (sql.includes("select enabled from channel_feature_flags")) return { rows: [{ enabled: true }] };
      if (sql.includes("select 1 from drafts")) return { rows: [{ "?column?": 1 }] };
      if (sql.includes("insert into today_source_refreshes")) {
        attempts.push([String(values[2]), String(values[3])]);
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
  };
}

describe("Today source refresh", () => {
  it("rejects a channel outside the selected project before refreshing sources", async () => {
    const db = database();
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes("user_project_preferences")) return { rows: [{ project_id: "7", user_id: "9", role: "owner", version: "1" }] };
      if (sql.includes("select id from channels")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
    await expect(refreshTodaySources(
      { actorUserId: 9, channelId: 18 },
      db as never,
      { opportunities: vi.fn(), results: vi.fn() },
    )).rejects.toMatchObject({ code: "channel_not_found" });
  });

  it("returns partial and records source-specific outcomes without erasing data", async () => {
    const db = database();
    const results = vi.fn().mockRejectedValue(new Error("provider down"));
    const result = await refreshTodaySources(
      { actorUserId: 9, channelId: 11 },
      db as never,
      {
        opportunities: vi.fn().mockResolvedValue([]),
        results,
      },
    );
    expect(result.availability).toBe("partial");
    expect(result.sources).toEqual([
      { source: "reviews", status: "success", errorCode: null },
      { source: "opportunities", status: "success", errorCode: null },
      { source: "results", status: "error", errorCode: "results_refresh_failed" },
    ]);
    expect(db.attempts).toEqual(expect.arrayContaining([
      ["reviews", "success"], ["opportunities", "success"], ["results", "error"],
    ]));
    expect(results).toHaveBeenCalledWith({ actorUserId: 9, projectId: 7, channelId: 11 });
  });

  it("returns unavailable only when no source can refresh", async () => {
    const db = database();
    db.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("user_project_preferences")) return { rows: [{ project_id: "7", user_id: "9", role: "owner", version: "1" }] };
      if (sql.includes("select id from channels")) return { rows: [{ id: "11" }] };
      if (sql.includes("select enabled from channel_feature_flags")) return { rows: [{ enabled: true }] };
      if (sql.includes("select 1 from drafts")) throw new Error("reviews down");
      if (sql.includes("insert into today_source_refreshes")) return { rows: [], values };
      throw new Error(`unexpected query: ${sql}`);
    });
    const result = await refreshTodaySources(
      { actorUserId: 9, channelId: 11 },
      db as never,
      {
        opportunities: vi.fn().mockRejectedValue(new Error("opportunities down")),
        results: vi.fn().mockRejectedValue(new Error("results down")),
      },
    );
    expect(result.availability).toBe("unavailable");
  });
});
