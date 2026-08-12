import { describe, expect, it, vi } from "vitest";
import {
  StatsProjectScopeError,
  requireStatsJobProjectScope,
  requireStatsProjectId,
} from "./stats-project-scope.mjs";

describe("stats BullMQ project scope", () => {
  it("accepts the actor only inside the exact active project", async () => {
    const memberships = new Set(["101:7", "202:8"]);
    const pool = {
      query: vi.fn(async (_sql, [projectId, userId]) => ({
        rows: memberships.has(`${projectId}:${userId}`) ? [{ role: "author" }] : [],
      })),
    };

    await expect(
      requireStatsJobProjectScope(pool, { userId: 7, projectId: 101 }, "collect"),
    ).resolves.toEqual({ userId: 7, projectId: 101, role: "author" });

    await expect(
      requireStatsJobProjectScope(pool, { userId: 7, projectId: 202 }, "collect"),
    ).rejects.toMatchObject({
      name: "StatsProjectScopeError",
      code: "project access denied",
    });

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("member.project_id = $1"),
      [101, 7],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("member.user_id = $2"),
      [202, 7],
    );
  });

  it("fails closed for legacy jobs without projectId before querying PostgreSQL", async () => {
    const pool = { query: vi.fn() };
    await expect(
      requireStatsJobProjectScope(pool, { userId: 7 }, "report"),
    ).rejects.toEqual(expect.objectContaining({ code: "bad projectId" }));
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("rejects malformed actor and project identifiers", async () => {
    const pool = { query: vi.fn() };
    await expect(
      requireStatsJobProjectScope(pool, { userId: "0", projectId: 101 }, "collect"),
    ).rejects.toBeInstanceOf(StatsProjectScopeError);
    expect(() => requireStatsProjectId("not-a-project", "cron-stats")).toThrow(
      "cron-stats: bad projectId",
    );
    expect(pool.query).not.toHaveBeenCalled();
  });
});
