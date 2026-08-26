import { describe, expect, it } from "vitest";

import {
  STABLE_RELEASE_CAPABILITIES,
  experimentalRoutesEnabled,
  isExperimentalReleaseApiPath,
  isExperimentalReleasePath,
  stableReleaseRedirect,
} from "./release-scope";

describe("stable release scope", () => {
  it("keeps the approved product workflow explicit", () => {
    expect(STABLE_RELEASE_CAPABILITIES).toEqual([
      "authentication",
      "projects",
      "onboarding",
      "telegram",
      "calendar",
      "composer",
      "sources-and-evidence",
      "editorial-approval",
      "publication",
      "operation-history",
      "basic-analytics",
      "settings",
    ]);
  });

  it("fails closed unless experimental routes are explicitly enabled", () => {
    expect(experimentalRoutesEnabled(undefined)).toBe(false);
    expect(experimentalRoutesEnabled("0")).toBe(false);
    expect(experimentalRoutesEnabled("true")).toBe(false);
    expect(experimentalRoutesEnabled("1")).toBe(true);
  });

  it("redirects experimental product and landing paths to stable destinations", () => {
    expect(isExperimentalReleasePath("/app/autopilot/month")).toBe(true);
    expect(stableReleaseRedirect("/app/autopilot/month")).toBe("/app/calendar");
    expect(stableReleaseRedirect("/variants")).toBe("/");
    expect(stableReleaseRedirect("/app/composer")).toBeNull();
    expect(stableReleaseRedirect("/app/settings")).toBeNull();
  });

  it("blocks experimental API families without blocking the stable workflow", () => {
    expect(isExperimentalReleaseApiPath("/api/autopilot/approve")).toBe(true);
    expect(isExperimentalReleasePath("/api/channels/connect-vk")).toBe(true);
    expect(isExperimentalReleaseApiPath("/api/onboarding/progress")).toBe(false);
    expect(isExperimentalReleaseApiPath("/api/autopilot/brief")).toBe(false);
    expect(isExperimentalReleaseApiPath("/api/autopilot/brief/suggest")).toBe(true);
    expect(isExperimentalReleaseApiPath("/api/knowledge/extract-profile")).toBe(false);
    expect(isExperimentalReleaseApiPath("/api/drafts/41")).toBe(false);
    expect(isExperimentalReleaseApiPath("/api/publication-operations")).toBe(false);
  });
});
