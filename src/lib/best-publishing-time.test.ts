import { describe, expect, it } from "vitest";
import { nextMoscowPublishingSlot, summarizeBestPublishingTime } from "./best-publishing-time";

describe("summarizeBestPublishingTime", () => {
  it("returns an auditable sample and low confidence for a one-post winning hour", () => {
    const result = summarizeBestPublishingTime([
      { published_at: "2026-08-01T16:00:00Z", views: 100 },
      { published_at: "2026-08-02T16:00:00Z", views: 120 },
      { published_at: "2026-08-03T07:00:00Z", views: 500 },
    ]);
    expect(result).toMatchObject({
      hour: 10,
      sampleSize: 1,
      totalSample: 3,
      averageViews: 500,
      confidence: "low",
    });
  });

  it("requires at least three verified posts with metrics", () => {
    expect(summarizeBestPublishingTime([
      { published_at: "2026-08-01T16:00:00Z", views: 100 },
      { published_at: "2026-08-02T16:00:00Z", views: 120 },
    ])).toBeNull();
  });
});

describe("nextMoscowPublishingSlot", () => {
  it("selects the next real occurrence of the Moscow hour", () => {
    expect(nextMoscowPublishingSlot(19, new Date("2026-08-01T15:00:00Z")).toISOString())
      .toBe("2026-08-01T16:00:00.000Z");
    expect(nextMoscowPublishingSlot(19, new Date("2026-08-01T17:00:00Z")).toISOString())
      .toBe("2026-08-02T16:00:00.000Z");
  });
});
