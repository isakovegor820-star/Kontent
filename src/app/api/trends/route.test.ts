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

import { GET, POST } from "./route";

describe("GET /api/trends internet feed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 1 });
    mocks.resolveChannel.mockResolvedValue(7);
  });

  it("returns only verified search posts scoped to the user and selected channel", async () => {
    mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("group by handle")) {
        expect(params).toEqual([1, 7, "рыбалка"]);
        return {
          rowCount: 1,
          rows: [{
            id: 91,
            handle: "fishing_public",
            title: "Рыбалка каждый день",
            subscribers: 12_000,
            status: "ready",
            last_error: null,
            collected_at: "2026-08-06T08:00:00.000Z",
            newest_post_at: "2026-08-06T07:00:00.000Z",
            posts: 1,
          }],
        };
      }
      if (sql.includes("select base.*, count(*) over()")) {
        expect(params).toEqual([1, 7, "рыбалка"]);
        return {
          rowCount: 1,
          rows: [{
            id: 91,
            competitor_id: 91,
            handle: "fishing_public",
            competitor_title: "Рыбалка каждый день",
            tg_msg_id: 345,
            text: "Как выбрать место для летней рыбалки",
            views: 4200,
            reactions: 84,
            photo_url: null,
            media: null,
            posted_at: "2026-08-06T07:00:00.000Z",
            median: null,
            matured: null,
            ratio: null,
            is_mature: true,
            period_count: 1,
            idea_id: null,
            topic: null,
            hook: null,
            structure: null,
            why_it_worked: null,
            ai_status: null,
            url: "https://t.me/fishing_public/345",
          }],
        };
      }
      if (sql.includes("select niche from content_brief")) {
        return { rowCount: 1, rows: [{ niche: "Рыбалка" }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const response = await GET(new NextRequest(
      "http://localhost/api/trends?scope=internet&period=week&channel=7&q=%D0%A0%D1%8B%D0%B1%D0%B0%D0%BB%D0%BA%D0%B0",
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      scope: "internet",
      status: { competitors: 1, periodPosts: 1, niche: "Рыбалка" },
      competitors: [{ handle: "fishing_public", status: "ready" }],
      items: [{
        id: 91,
        text: "Как выбрать место для летней рыбалки",
        link: "https://t.me/fishing_public/345",
        isMature: true,
      }],
    });
    expect(mocks.resolveChannel).toHaveBeenCalledWith(1, 7);
  });

  it("does not query internet results without an owned channel", async () => {
    mocks.resolveChannel.mockResolvedValue(null);

    const response = await GET(new NextRequest(
      "http://localhost/api/trends?scope=internet&channel=999",
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      scope: "internet",
      status: { competitors: 0, periodPosts: 0 },
      items: [],
    });
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

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
