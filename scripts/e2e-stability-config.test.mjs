import { describe, expect, it } from "vitest";

import {
  createE2eStabilityPlan,
  resolveE2eStabilityEngines,
  resolveE2eStabilityInitialBuildMode,
  resolveE2eStabilityRuns,
} from "./e2e-stability-config.mjs";

describe("real E2E stability configuration", () => {
  it("defaults to thirty complete three-engine cycles", () => {
    const plan = createE2eStabilityPlan({});
    expect(plan.runs).toBe(30);
    expect(plan.engines).toEqual(["chromium", "firefox", "webkit"]);
    expect(plan.expectedJourneys).toBe(90);
    expect(plan.journeys[0]).toEqual({
      cycle: 1,
      engine: "chromium",
      buildMode: "build",
      artifactDirectory: "run-01/chromium",
    });
    expect(plan.journeys.at(-1)).toMatchObject({
      cycle: 30,
      engine: "webkit",
      buildMode: "reuse",
      artifactDirectory: "run-30/webkit",
    });
  });

  it("bounds run count and rejects duplicate or unknown engines", () => {
    expect(resolveE2eStabilityRuns("1")).toBe(1);
    expect(() => resolveE2eStabilityRuns("31")).toThrowError(
      "E2E_STABILITY_RUNS must be an integer between 1 and 30",
    );
    expect(resolveE2eStabilityEngines("webkit,chromium")).toEqual(["webkit", "chromium"]);
    expect(() => resolveE2eStabilityEngines(" ")).toThrowError(
      "E2E_STABILITY_ENGINES must not be empty",
    );
    expect(() => resolveE2eStabilityEngines("webkit,webkit")).toThrowError(
      "E2E_STABILITY_ENGINES must contain unique browser engines",
    );
    expect(() => resolveE2eStabilityEngines("chrome")).toThrowError(
      "E2E_BROWSER must be one of: chromium, firefox, webkit",
    );
  });

  it("allows reuse only as an explicit initial mode", () => {
    expect(resolveE2eStabilityInitialBuildMode()).toBe("build");
    expect(resolveE2eStabilityInitialBuildMode("reuse")).toBe("reuse");
    expect(createE2eStabilityPlan({
      runs: 1,
      engines: "firefox,webkit",
      initialBuildMode: "reuse",
    }).journeys.map((journey) => journey.buildMode)).toEqual(["reuse", "reuse"]);
  });
});
