import { resolveE2eBrowserEngine } from "./e2e-browser-config.mjs";

export function resolveE2eStabilityRuns(value) {
  const raw = String(value || "30").trim();
  const runs = Number(raw);
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 30) {
    throw new Error("E2E_STABILITY_RUNS must be an integer between 1 and 30");
  }
  return runs;
}

export function resolveE2eStabilityEngines(value) {
  const raw = String(value || "chromium,firefox,webkit").trim();
  if (!raw) throw new Error("E2E_STABILITY_ENGINES must not be empty");
  const engines = raw.split(",").map((engine) => resolveE2eBrowserEngine(engine.trim()));
  if (engines.length === 0 || new Set(engines).size !== engines.length) {
    throw new Error("E2E_STABILITY_ENGINES must contain unique browser engines");
  }
  return Object.freeze(engines);
}

export function resolveE2eStabilityInitialBuildMode(value) {
  const mode = String(value || "build").trim().toLowerCase();
  if (mode !== "build" && mode !== "reuse") {
    throw new Error("E2E_STABILITY_INITIAL_BUILD_MODE must be build or reuse");
  }
  return mode;
}

export function createE2eStabilityPlan({ runs, engines, initialBuildMode = "build" }) {
  const resolvedRuns = resolveE2eStabilityRuns(runs);
  const resolvedEngines = resolveE2eStabilityEngines(engines);
  const firstBuildMode = resolveE2eStabilityInitialBuildMode(initialBuildMode);
  const journeys = [];
  for (let cycle = 1; cycle <= resolvedRuns; cycle += 1) {
    for (const engine of resolvedEngines) {
      journeys.push(Object.freeze({
        cycle,
        engine,
        buildMode: journeys.length === 0 ? firstBuildMode : "reuse",
        artifactDirectory: `run-${String(cycle).padStart(2, "0")}/${engine}`,
      }));
    }
  }
  return Object.freeze({
    runs: resolvedRuns,
    engines: resolvedEngines,
    expectedJourneys: resolvedRuns * resolvedEngines.length,
    journeys: Object.freeze(journeys),
  });
}
