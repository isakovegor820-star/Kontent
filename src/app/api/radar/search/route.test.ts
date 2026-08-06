import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  session: vi.fn(),
  resolveChannel: vi.fn(),
  enqueue: vi.fn(),
  trusted: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/autopilot", () => ({ resolveChannel: mocks.resolveChannel }));
vi.mock("@/lib/radar-search-queue", () => ({ enqueueRadarSearch: mocks.enqueue }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: mocks.trusted }));

import { GET, POST } from "./route";

const queuedRun = {
  id: "91",
  query: "садоводство",
  normalized_query: "садоводство",
  status: "queued",
  stage: "queued",
  progress: 0,
  provider: null,
  local_count: 0,
  external_count: 0,
  error_code: null,
  error_message: null,
  cache_expires_at: "2026-08-07T10:00:00.000Z",
  created_at: "2026-08-06T10:00:00.000Z",
  updated_at: "2026-08-06T10:00:00.000Z",
  completed_at: null,
};

describe("hybrid radar search route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.mockResolvedValue({ id: 7 });
    mocks.resolveChannel.mockResolvedValue(11);
    mocks.trusted.mockReturnValue(true);
    mocks.enqueue.mockResolvedValue({ jobId: "radar-search-91", recovered: false });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("insert into radar_search_runs")) return { rowCount: 1, rows: [queuedRun] };
      if (sql.includes("queue_confirmed_at = now()")) return { rowCount: 1, rows: [queuedRun] };
      return { rowCount: 0, rows: [] };
    });
  });

  it("returns local results without requiring an external provider", async () => {
    const response = await GET(new NextRequest("http://localhost/api/radar/search?q=рыбалка&channel=11"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      channelId: 11,
      query: "рыбалка",
      results: [],
      shouldExpand: true,
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("creates a user-scoped background run and returns immediately", async () => {
    const response = await POST(new NextRequest("http://localhost/api/radar/search", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "radar_garden_1234" },
      body: JSON.stringify({ q: "Садоводство", channelId: 11 }),
    }));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      cached: false,
      run: { id: 91, status: "queued" },
    });
    expect(mocks.enqueue).toHaveBeenCalledWith({ runId: 91, userId: 7 });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("insert into radar_search_runs"),
      [7, 11, "radar_garden_1234", "Садоводство", "садоводство", 0],
    );
  });

  it("keeps local results available when queue dispatch fails", async () => {
    mocks.enqueue.mockRejectedValue(new Error("redis offline"));
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("insert into radar_search_runs")) return { rowCount: 1, rows: [queuedRun] };
      if (sql.includes("error_code = 'queue_unavailable'")) {
        return { rowCount: 1, rows: [{ ...queuedRun, status: "failed", stage: "failed", progress: 100 }] };
      }
      return { rowCount: 0, rows: [] };
    });
    const response = await POST(new NextRequest("http://localhost/api/radar/search", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "radar_garden_5678" },
      body: JSON.stringify({ q: "садоводство", channelId: 11 }),
    }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "queue_unavailable",
      results: [],
      run: { status: "failed" },
    });
  });

  it("never exposes a run owned by another user", async () => {
    mocks.query.mockResolvedValue({ rowCount: 0, rows: [] });
    const response = await GET(new NextRequest("http://localhost/api/radar/search?run=999"));
    expect(response.status).toBe(404);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("user_id = $2"), [999, 7]);
  });

  it("shows a popular publication once, preferring its trend classification", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("from radar_search_runs where id")) {
        return { rowCount: 1, rows: [{
          ...queuedRun,
          query: "морская рыбалка",
          normalized_query: "морская рыбалка",
          status: "ready",
          stage: "ready",
          progress: 100,
        }] };
      }
      if (sql.includes("from radar_search_results")) {
        const shared = {
          id: "201",
          action_id: "201",
          provider: "web",
          origin: "web",
          title: "Морская рыбалка",
          handle: "sea_fishing",
          text: "Свежий отчёт о морской рыбалке",
          url: "https://t.me/sea_fishing/42",
          quality_score: 68,
          reason: "Проверено",
          verified: true,
        };
        return { rowCount: 2, rows: [
          { ...shared, kind: "post" },
          { ...shared, id: "202", action_id: "202", kind: "trend" },
        ] };
      }
      return { rowCount: 0, rows: [] };
    });
    const response = await GET(new NextRequest("http://localhost/api/radar/search?run=91"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      results: [{ kind: "trend", url: "https://t.me/sea_fishing/42" }],
    });
  });
});
