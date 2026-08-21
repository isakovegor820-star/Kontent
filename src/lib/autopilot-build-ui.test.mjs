import { describe, expect, it } from "vitest";

import { autopilotBuildSpinnerClass } from "./autopilot-build-ui.mjs";

describe("Autopilot build UI motion", () => {
  it("removes the spinner animation when reduced motion is requested", () => {
    expect(autopilotBuildSpinnerClass(true)).toBe("");
    expect(autopilotBuildSpinnerClass(false)).toBe("animate-spin");
    expect(autopilotBuildSpinnerClass(null)).toBe("animate-spin");
  });
});
