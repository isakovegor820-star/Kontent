import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  session: vi.fn(),
  resolveChannel: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/autopilot", () => ({ resolveChannel: mocks.resolveChannel }));

import { GET } from "./route";

const payload = {
  summary: {
    posts: 12,
    sources: 3,
    views: 4200,
    reactions: 126,
    avgViews: 350,
    trends: 2,
    engagementRate: 3,
  },
  previous: { posts: 8, views: 2100 },
  series: [{ bucket: "2026-08-06T07:00:00.000Z", posts: 2, views: 700 }],
  topItems: [{
    item_id: "42",
    source_title: "Рыбалка",
    text: "Как ловить щуку",
    url: "https://t.me/fishing/42",
    posted_at: "2026-08-06T07:00:00.000Z",
    views: 700,
    reactions: 20,
    trend_value: 1.8,
    quality_score: null,
    reason: "Публикация добавленного конкурента",
  }],
  from: "2026-07-30T08:00:00.000Z",
  to: "2026-08-06T08:00:00.000Z",
};

describe("GET /api/trends/stats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.mockResolvedValue({ id: 7 });
    mocks.resolveChannel.mockResolvedValue(11);
    mocks.query.mockResolvedValue({ rowCount: 1, rows: [{ payload }] });
  });

  it("aggregates the selected channel's own competitor base", async () => {
    const response = await GET(new NextRequest(
      "http://localhost/api/trends/stats?source=own&period=week&topic=Рыбалка&channel=11",
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      source: "own",
      period: "week",
      topic: "рыбалка",
      channelId: 11,
      comparison: { previousPosts: 8, previousViews: 2100 },
      summary: { posts: 12, postsChange: 50, viewsChange: 100 },
      topItems: [{ id: "42", ratio: 1.8 }],
    });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("competitor.channel_id = $1"),
      [11, "рыбалка"],
    );
    expect(mocks.query.mock.calls[0][0]).toContain("having count(*) >= 5");
  });

  it("keeps internet statistics user- and channel-scoped", async () => {
    const response = await GET(new NextRequest(
      "http://localhost/api/trends/stats?source=internet&period=month&channel=11",
    ));
    expect(response.status).toBe(200);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringMatching(/result\.user_id = \$1[\s\S]+run\.channel_id is not distinct from \$2/u),
      [7, 11, ""],
    );
  });

  it("uses the public editorial collection without leaking another user's data", async () => {
    const response = await GET(new NextRequest(
      "http://localhost/api/trends/stats?source=collection&period=quarter&topic=садоводство",
    ));
    expect(response.status).toBe(200);
    expect(mocks.resolveChannel).not.toHaveBeenCalled();
    const [sql, params] = mocks.query.mock.calls[0];
    expect(sql).toContain("from trend_posts post");
    expect(sql).not.toContain("radar_search_results");
    expect(params).toEqual(["садоводство"]);
  });

  it("requires an owned channel for private statistics", async () => {
    mocks.resolveChannel.mockResolvedValue(null);
    const response = await GET(new NextRequest(
      "http://localhost/api/trends/stats?source=internet&period=day&channel=999",
    ));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "no_channel" });
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
