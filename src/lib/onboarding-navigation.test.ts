import { describe, expect, it } from "vitest";

import {
  completedOnboardingFallbackRoute,
  onboardingEntryWasIncomplete,
} from "./onboarding-navigation";

describe("onboarding completion navigation", () => {
  it("redirects an already completed visitor out of onboarding", () => {
    const startedIncomplete = onboardingEntryWasIncomplete(null, true);
    expect(startedIncomplete).toBe(false);
    expect(completedOnboardingFallbackRoute(true, startedIncomplete)).toBe("/app/calendar");
  });

  it("lets the final step open the exact draft after a fresh completion", () => {
    const startedIncomplete = onboardingEntryWasIncomplete(null, false);
    expect(startedIncomplete).toBe(true);
    expect(completedOnboardingFallbackRoute(true, startedIncomplete)).toBeNull();
  });
});
