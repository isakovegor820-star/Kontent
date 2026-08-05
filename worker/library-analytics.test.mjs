import { describe, expect, it, vi } from "vitest";
import { persistCompetitorLibraryAnalytics } from "./library-analytics.mjs";

describe("persistCompetitorLibraryAnalytics", () => {
  it("stores formula version and the exact top-decile + Lift>=5 hit flag", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }) };
    const now = new Date("2026-08-05T10:00:00.000Z");
    const posts = [
      ...Array.from({ length: 9 }, (_, index) => ({
        id: index + 1,
        views: 100,
        reactions: 5,
        media: "text",
        posted_at: new Date(now.getTime() - (72 + index) * 3_600_000).toISOString(),
      })),
      {
        id: 10,
        views: 600,
        reactions: 30,
        media: "text",
        posted_at: new Date(now.getTime() - 80 * 3_600_000).toISOString(),
      },
    ];
    const scored = await persistCompetitorLibraryAnalytics({ pool, channelId: 7, sourceId: 9, posts, now });
    expect(scored.filter((item) => item.isHit).map((item) => item.id)).toEqual([10]);
    const hitUpdate = pool.query.mock.calls.find((call) => call[1]?.[0] === 10 && call[1]?.length > 3);
    expect(hitUpdate?.[1]).toEqual(expect.arrayContaining([10, true, expect.any(Number), "aurora-library-v1"]));
    expect(pool.query).toHaveBeenCalledTimes(11);
    expect(pool.query.mock.calls[0][0]).toContain("is_hit = false");
  });
});
