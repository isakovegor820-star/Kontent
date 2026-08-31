import { describe, expect, it } from "vitest";

import { selectFreshJourneyFailureDetail } from "./e2e-stability-artifacts.mjs";

describe("stability journey failure evidence", () => {
  it("does not attribute a stale result.json error to a new failed process", () => {
    expect(selectFreshJourneyFailureDetail({
      resultError: "old snapshot changed",
      resultModifiedAtMs: 1_000,
      journeyStartedAtMs: 2_000,
      output: "Error: another Aurora production build is running (pid 42)",
    })).toBe(": another Aurora production build is running (pid 42)");
  });

  it("uses a result produced by the current journey when one exists", () => {
    expect(selectFreshJourneyFailureDetail({
      resultError: "current browser failure",
      resultModifiedAtMs: 2_001,
      journeyStartedAtMs: 2_000,
      output: "Error: wrapper failure",
    })).toBe(": current browser failure");
  });
});
