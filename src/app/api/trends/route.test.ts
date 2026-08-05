import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  add: vi.fn(),
  getSessionUser: vi.fn(),
  resolveChannel: vi.fn(),
}));

const globalRefreshState = [
  {
    id: 10,
    status: "ready",
    last_error: null,
    collected_at: "2026-07-31T10:00:00.000Z",
  },
  {
    id: 11,
    status: "error",
    last_error: "temporary scrape error",
    collected_at: "2026-07-31T11:00:00.000Z",
  },
];

vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/queue", () => ({ getStatsQueue: () => ({ add: mocks.add }) }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/autopilot", () => ({ resolveChannel: mocks.resolveChannel }));

import { POST } from "./route";

describe("POST /api/trends", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 1 });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("insert into trend_refresh_operations")) return { rowCount: 1, rows: [{ id: "71" }] };
      if (sql.includes("before_state as materialized")) {
        return { rowCount: globalRefreshState.length, rows: globalRefreshState };
      }
      return { rowCount: 1, rows: [] };
    });
    mocks.add.mockResolvedValue({ id: "trend-now" });
  });

  it("queues an immediate global collection instead of waiting for cron", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/trends?scope=global", {
        method: "POST",
        headers: { "idempotency-key": "trend_global_1234" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, queued: 2, global: true });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("before_state as materialized"));
    expect(mocks.add).toHaveBeenCalledWith(
      "trend-now",
      {},
      expect.objectContaining({
        jobId: "trend-now",
        removeOnComplete: true,
        attempts: 2,
      }),
    );
  });

  it("does not claim success when Redis rejects the job", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.add.mockRejectedValue(new Error("redis down"));

    const response = await POST(
      new NextRequest("http://localhost/api/trends?scope=global", {
        method: "POST",
        headers: { "idempotency-key": "trend_global_5678" },
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "server" });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("jsonb_to_recordset"),
      [JSON.stringify(globalRefreshState)],
    );
    error.mockRestore();
  });

  it("restores only the niche competitor whose job was rejected", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const competitors = [
      {
        id: 21,
        status: "ready",
        last_error: null,
        collected_at: "2026-07-31T12:00:00.000Z",
      },
      {
        id: 22,
        status: "error",
        last_error: "old scrape error",
        collected_at: "2026-07-31T13:00:00.000Z",
      },
      {
        id: 23,
        status: "ready",
        last_error: null,
        collected_at: "2026-07-31T14:00:00.000Z",
      },
    ];
    mocks.resolveChannel.mockResolvedValue(7);
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("insert into trend_refresh_operations")) return { rowCount: 1, rows: [{ id: "72" }] };
      if (sql.includes("select id, status, last_error, collected_at") && sql.includes("from competitors")) {
        return { rowCount: competitors.length, rows: competitors };
      }
      return { rowCount: 1, rows: [] };
    });
    mocks.add
      .mockResolvedValueOnce({ id: "competitor-21" })
      .mockRejectedValueOnce(new Error("redis down"));

    const response = await POST(new NextRequest("http://localhost/api/trends", {
      method: "POST",
      headers: { "idempotency-key": "trend_niche_1234" },
    }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "server" });
    expect(mocks.add).toHaveBeenCalledTimes(2);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("collected_at is not distinct from $4"),
      [22, "error", "old scrape error", "2026-07-31T13:00:00.000Z"],
    );
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining("update competitors set status = 'pending'"),
      [23],
    );
    error.mockRestore();
  });

  it("replays an accepted refresh without another write or queue job", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("insert into trend_refresh_operations")) return { rowCount: 0, rows: [] };
      if (sql.includes("from trend_refresh_operations")) {
        return {
          rowCount: 1,
          rows: [{
            id: "80",
            idempotency_key: "trend_replay_1234",
            fingerprint: "global",
            status: "accepted",
            queued_count: 2,
          }],
        };
      }
      throw new Error("unexpected write");
    });
    const response = await POST(new NextRequest("http://localhost/api/trends?scope=global", {
      method: "POST",
      headers: { "idempotency-key": "trend_replay_1234" },
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, queued: 2, replayed: true });
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("reports a concurrent refresh without duplicating the queue operation", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("insert into trend_refresh_operations")) return { rowCount: 0, rows: [] };
      return {
        rowCount: 1,
        rows: [{
          id: "81",
          idempotency_key: "another_key_1234",
          fingerprint: "global",
          status: "dispatching",
          queued_count: 0,
        }],
      };
    });
    const response = await POST(new NextRequest("http://localhost/api/trends?scope=global", {
      method: "POST",
      headers: { "idempotency-key": "trend_parallel_1234" },
    }));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "request_in_progress" });
    expect(mocks.add).not.toHaveBeenCalled();
  });
});
