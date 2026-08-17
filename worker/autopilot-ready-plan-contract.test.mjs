import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = await readFile(new URL("../worker.mjs", import.meta.url), "utf8");

describe("Autopilot ready-plan generation contract", () => {
  it("never accepts a provider response stopped at the token limit", () => {
    expect(source).not.toContain('acceptLengthLimitedOutput: surface === "autopilot-plan"');
  });

  it("uses the strict complete-plan boundary before persistence", () => {
    expect(source).toContain("const AUTOPILOT_QUALITY_REWRITE_ATTEMPTS = 6;");
    expect(source).toContain("if (!autopilotBuildComplete(N, topics, items))");
    expect(source).not.toContain("autopilotDraftsDeliverable");
  });
});
