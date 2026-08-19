import { describe, expect, it } from "vitest";
import {
  TREND_BASELINE_DAYS,
  TREND_MATURE_HOURS,
  TREND_PERIODS,
  parseTrendFeedScope,
  parseTrendPeriod,
} from "./trend-period";

describe("trend periods", () => {
  it("opens the fresh daily feed by default", () => {
    expect(parseTrendPeriod(null)).toBe("today");
    expect(parseTrendPeriod("unknown")).toBe("today");
    expect(TREND_PERIODS.today.sort).toBe("newest");
  });

  it("keeps the weekly feed chronological", () => {
    expect(parseTrendPeriod("week")).toBe("week");
    expect(TREND_PERIODS.week.sort).toBe("newest");
  });

  it("separates recent, mature hits from the fresh feed", () => {
    expect(parseTrendPeriod("hits")).toBe("hits");
    expect(TREND_PERIODS.hits.sort).toBe("ratio");
    expect(TREND_MATURE_HOURS).toBe(48);
    expect(TREND_BASELINE_DAYS).toBe(90);
  });

  it("opens the publication search only when the URL asks for internet", () => {
    expect(parseTrendFeedScope(null)).toBe("niche");
    expect(parseTrendFeedScope("internet")).toBe("internet");
    expect(parseTrendFeedScope("global")).toBe("global");
    expect(parseTrendFeedScope("radar")).toBe("niche");
  });
});
