import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const worker = readFileSync(new URL("../worker.mjs", import.meta.url), "utf8");

describe("Autopilot build queue runtime reconciliation", () => {
  it("reconciles durable building plans on startup and periodically", () => {
    expect(worker).toContain("reconcileBuildingAutopilotPlans");
    expect(worker).toContain("await reconcileAutopilotBuildQueue().catch");
    expect(worker).toContain("const autopilotBuildQueueTimer = setInterval");
    expect(worker).toContain("autopilotBuildQueueTimer.unref()");
  });
});
