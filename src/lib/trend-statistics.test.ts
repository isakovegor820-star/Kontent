import { describe, expect, it } from "vitest";

import {
  normalizeTrendTopic,
  parseTrendStatPeriod,
  parseTrendStatSource,
  trendPercentChange,
} from "./trend-statistics";

describe("trend statistics helpers", () => {
  it("uses safe defaults for unknown filters", () => {
    expect(parseTrendStatSource("unknown")).toBe("own");
    expect(parseTrendStatPeriod("unknown")).toBe("week");
  });

  it("normalizes a free-form Russian topic", () => {
    expect(normalizeTrendTopic("  Морская рыбалка!!!  ")).toBe("морская рыбалка");
  });

  it("compares the selected period with the previous equal period", () => {
    expect(trendPercentChange(15, 10)).toBe(50);
    expect(trendPercentChange(5, 10)).toBe(-50);
    expect(trendPercentChange(5, 0)).toBeNull();
  });
});
