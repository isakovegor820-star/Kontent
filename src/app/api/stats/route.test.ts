import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));

import { GET } from "./route";

function membership(projectId = 44, role = "author") {
  return {
    rows: [{ project_id: String(projectId), user_id: "7", role, version: "2" }],
    rowCount: 1,
  };
}

describe("GET /api/stats availability", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 instead of an empty-account success for an expired session", async () => {
    mocks.getSessionUser.mockResolvedValueOnce(null);

    const response = await GET(new NextRequest("http://localhost/api/stats?channel=1"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      hasChannel: false,
      error: "unauthorized",
    });
  });

  it("returns 503 instead of pretending that a PostgreSQL outage means no channel", async () => {
    mocks.getSessionUser.mockResolvedValueOnce({ id: 7 });
    mocks.query
      .mockResolvedValueOnce(membership())
      .mockRejectedValueOnce(new Error("database unavailable"));

    const response = await GET(new NextRequest("http://localhost/api/stats?channel=1"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      hasChannel: false,
      error: "stats_unavailable",
    });
  });

  it("returns 403 and performs no analytics read without selected-project membership", async () => {
    mocks.getSessionUser.mockResolvedValueOnce({ id: 7 });
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await GET(new NextRequest("http://localhost/api/stats?channel=1"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      hasChannel: false,
      error: "access_denied",
    });
    expect(mocks.query).toHaveBeenCalledOnce();
  });

  it("does not fall back to a selected-project channel for a foreign channel id", async () => {
    mocks.getSessionUser.mockResolvedValueOnce({ id: 7 });
    mocks.query
      .mockResolvedValueOnce(membership())
      .mockResolvedValueOnce({ rows: [{ id: "17", title: "Свой канал" }], rowCount: 1 });

    const response = await GET(new NextRequest("http://localhost/api/stats?channel=999"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ hasChannel: false });
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it("scopes every analytics query to the server-selected project for team members", async () => {
    mocks.getSessionUser.mockResolvedValueOnce({ id: 7 });
    mocks.query.mockImplementation(async (sqlValue: string) => {
      const sql = sqlValue.replace(/\s+/g, " ").trim();
      if (sql.includes("from user_project_preferences preference")) return membership();
      if (sql.startsWith("select channel.id, channel.title, project.timezone")) {
        return { rows: [{ id: "17", title: "Судебная практика", timezone: "Europe/Saratov" }], rowCount: 1 };
      }
      if (sql.startsWith("select to_char(stats.snapshot_date")) return { rows: [], rowCount: 0 };
      if (sql.startsWith("select p.id, p.text")) {
        expect(sql).toContain("item.project_id = p.project_id");
        expect(sql).toContain("campaign.project_id = item.project_id");
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("select competitor.id")) return { rows: [], rowCount: 0 };
      if (sql.startsWith("select greatest(")) return { rows: [{ t: null }], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    });

    const response = await GET(new NextRequest("http://localhost/api/stats?channel=17"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      hasChannel: true,
      channelTitle: "Судебная практика",
      totals: { published: 0 },
    });
    expect(mocks.query).toHaveBeenCalledTimes(6);
    for (const [sqlValue, params] of mocks.query.mock.calls.slice(1)) {
      expect(String(sqlValue)).toContain("project_id");
      expect(params).toContain(44);
    }
  });

  it("normalizes published post ids for joins with /api/posts", async () => {
    mocks.getSessionUser.mockResolvedValueOnce({ id: 7 });
    mocks.query.mockImplementation(async (sqlValue: string, params?: unknown[]) => {
      const sql = sqlValue.replace(/\s+/g, " ").trim();
      if (sql.includes("from user_project_preferences preference")) return membership();
      if (sql.startsWith("select channel.id, channel.title, project.timezone")) {
        return { rows: [{ id: "17", title: "Судебная практика", timezone: "Europe/Saratov" }], rowCount: 1 };
      }
      if (sql.startsWith("select to_char(stats.snapshot_date")) {
        expect(params).toEqual([17, 44, "Europe/Saratov", 90]);
        return { rows: [
          { snapshot_date: "2026-08-01", subscribers: 1000 },
          { snapshot_date: "2026-08-28", subscribers: 1020 },
        ], rowCount: 2 };
      }
      if (sql.startsWith("select p.id, p.text")) {
        return {
          rows: [{
            id: "501",
            text: "Опубликованный пост",
            published_at: "2026-08-24T10:00:00.000Z",
            status: "published",
            verification_state: "verified",
            stats_state: "ok",
            views: 120,
            reactions: 12,
            monthly_campaign_id: null,
            monthly_campaign_goal: null,
            monthly_item_id: null,
            monthly_item_title: null,
            period_bucket: "current",
          }],
          rowCount: 1,
        };
      }
      if (sql.startsWith("select competitor.id")) return { rows: [{
        id: "91",
        network: "tg",
        handle: "public_competitor",
        title: "Открытый конкурент",
        custom_title: null,
        subscribers: 5000,
        status: "ready",
        collected_at: "2026-08-28T10:00:00.000Z",
        posts_count: "8",
        with_views: "8",
        median_views: "450",
        avg_interactions: "24",
        first_subscribers: "4900",
        latest_subscribers: "5000",
      }], rowCount: 1 };
      if (sql.startsWith("select greatest(")) return { rows: [{ t: null }], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    });

    const response = await GET(new NextRequest("http://localhost/api/stats?channel=17&days=90"));

    await expect(response.json()).resolves.toMatchObject({
      posts: [{ id: 501, views: 120, reactions: 12 }],
      period: { days: 90, timeZone: "Europe/Saratov" },
      subscriberGrowth: 20,
      competitors: [{ id: 91, medianViews: 450, subscriberGrowth: 100 }],
    });
  });
});
