import { describe, expect, it } from "vitest";

import {
  analyticsPercentChange,
  median,
  parseAnalyticsPeriodDays,
  subscriberGrowth,
  summarizeDashboardPeriod,
} from "./analytics-dashboard";

const post = (views: number | null, reactions: number | null = null) => ({
  status: "published",
  verification_state: "verified",
  views,
  reactions,
});

describe("analytics dashboard calculations", () => {
  it("accepts only supported report periods", () => {
    expect(parseAnalyticsPeriodDays("7")).toBe(7);
    expect(parseAnalyticsPeriodDays("90")).toBe(90);
    expect(parseAnalyticsPeriodDays("365")).toBe(365);
    expect(parseAnalyticsPeriodDays("14")).toBe(30);
    expect(parseAnalyticsPeriodDays(null)).toBe(30);
  });

  it("keeps missing baselines unknown instead of inventing zero change", () => {
    expect(analyticsPercentChange(120, 100)).toBe(20);
    expect(analyticsPercentChange(120, 0)).toBeNull();
    expect(subscriberGrowth([{ snapshot_date: "2026-08-28", subscribers: 500 }])).toBeNull();
  });

  it("uses medians and comparable engagement cohorts", () => {
    expect(median([100, 900, 200, 300])).toBe(250);
    const summary = summarizeDashboardPeriod(
      [post(100, 10), post(300, 15), post(500, null)],
      [post(100, 5), post(100, 5)],
    );
    expect(summary.current.avgViews).toBe(300);
    expect(summary.medianViews).toBe(300);
    expect(summary.engagementRate).toBe(6.3);
    expect(summary.comparisons.averageViewsPercent).toBe(200);
    expect(summary.comparisons.engagementPoints).toBe(1.3);
  });
});
