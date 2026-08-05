import { describe, expect, it } from "vitest";
import { analyticsConfidence, summarizeAnalyticsCohort } from "./analytics-cohort";

describe("summarizeAnalyticsCohort", () => {
  it("uses the same verified cohort for totals, average and visible rows", () => {
    const rows = [
      { status: "published", verification_state: "verified", views: 5 },
      ...Array.from({ length: 16 }, () => ({
        status: "published_unverified",
        verification_state: "unverified",
        views: null,
      })),
    ];

    const result = summarizeAnalyticsCohort(rows);
    expect(result.verifiedPosts).toHaveLength(1);
    expect(result.withMetrics).toHaveLength(1);
    expect(result.totalViews).toBe(5);
    expect(result.avgViews).toBe(5);
    expect(result.unverified).toBe(16);
  });

  it("excludes missing posts even when they retain historical metrics", () => {
    const result = summarizeAnalyticsCohort([
      { status: "missing", verification_state: "missing", views: 1_000 },
      { status: "published", verification_state: "verified", views: 4 },
      { status: "published", verification_state: "verified", views: null },
    ]);

    expect(result.missing).toBe(1);
    expect(result.verifiedPosts).toHaveLength(2);
    expect(result.totalViews).toBe(4);
    expect(result.avgViews).toBe(4);
  });

  it("does not present tiny samples as a confident weekly conclusion", () => {
    expect(analyticsConfidence(0)).toBe("insufficient");
    expect(analyticsConfidence(1)).toBe("insufficient");
    expect(analyticsConfidence(2)).toBe("low");
    expect(analyticsConfidence(5)).toBe("medium");
    expect(analyticsConfidence(10)).toBe("high");
  });
});
