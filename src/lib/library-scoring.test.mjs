import { describe, expect, it } from "vitest";
import {
  LIBRARY_FORMULA_VERSION,
  libraryMedian,
  libraryPercentileRank,
  scoreLibraryCohorts,
} from "./library-scoring.mjs";

const NOW = new Date("2026-08-05T10:00:00.000Z");

function row(id, views, reactions, ageHours, extra = {}) {
  return {
    id,
    channelId: 11,
    sourceId: 21,
    media: "text",
    views,
    reactions,
    postedAt: new Date(NOW.getTime() - ageHours * 3_600_000).toISOString(),
    ...extra,
  };
}

describe("library analytics formula", () => {
  it("uses the published Lift, Bayes ER, Velocity, VelocityZ and Freshness formulas", () => {
    const scored = scoreLibraryCohorts(
      [row(1, 100, 10, 10), row(2, 200, 40, 20), row(3, 300, 30, 30)],
      { now: NOW, bayesK: 100, halfLifeHours: 100, minCohortSize: 1, minMedianViews: 0 },
    );
    const first = scored.find((item) => item.id === 1);
    expect(first.medianViews).toBe(200);
    expect(first.lift).toBeCloseTo(101 / 201, 8);
    const meanEr = (0.1 + 0.2 + 0.1) / 3;
    expect(first.erBayes).toBeCloseTo((10 + 100 * meanEr) / (100 + 100), 8);
    expect(first.velocity).toBe(10);
    expect(first.freshness).toBeCloseTo(2 ** -0.1, 8);
    expect(first.velocityZ).not.toBeNull();
    expect(first.formulaVersion).toBe(LIBRARY_FORMULA_VERSION);
  });

  it("redistributes score weight across available metrics", () => {
    const scored = scoreLibraryCohorts(
      [row(1, 100, null, 10), row(2, 200, null, 20)],
      { now: NOW, minCohortSize: 1, minMedianViews: 0 },
    );
    expect(scored.every((item) => item.missingMetrics.includes("erBayes"))).toBe(true);
    for (const item of scored) expect(item.availableWeight).toBeCloseTo(0.8, 8);
    expect(scored.every((item) => item.score != null && item.score >= 0 && item.score <= 100)).toBe(true);
  });

  it("never compares different sources or formats in one cohort", () => {
    const scored = scoreLibraryCohorts(
      [
        row(1, 100, 10, 10),
        row(2, 1000, 100, 10, { sourceId: 22 }),
        row(3, 500, 50, 10, { media: "video" }),
      ],
      { now: NOW, minCohortSize: 1, minMedianViews: 0 },
    );
    expect(new Set(scored.map((item) => item.cohortKey)).size).toBe(3);
    expect(scored.map((item) => item.lift)).toEqual([1, 1, 1]);
  });

  it("marks a hit only at the author's top decile and Lift >= 5", () => {
    const normal = Array.from({ length: 9 }, (_, index) => row(index + 1, 100, 5, 72 + index));
    const scored = scoreLibraryCohorts(
      [...normal, row(10, 600, 30, 80)],
      { now: NOW, minCohortSize: 8, minMedianViews: 20 },
    );
    expect(scored.filter((item) => item.isHit).map((item) => item.id)).toEqual([10]);
    expect(scored.find((item) => item.id === 10).lift).toBeCloseTo(601 / 101, 8);
  });

  it("does not create noisy hits from a thin cohort", () => {
    const scored = scoreLibraryCohorts(
      [row(1, 1, 0, 72), row(2, 100, 1, 80)],
      { now: NOW },
    );
    expect(scored.some((item) => item.isHit)).toBe(false);
    expect(scored.every((item) => item.dataQuality === "low")).toBe(true);
  });

  it("uses stable median and tie-aware percentile ranks", () => {
    expect(libraryMedian([4, 1, 3, 2])).toBe(2.5);
    expect(libraryPercentileRank([1, 2, 2, 4], 2)).toBeCloseTo(0.5, 8);
  });
});
