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
      "today",
      "studio",
      "autopilot",
      "trends-and-recon",
      "opportunities",
      "site-analysis",
      "growth",
      "knowledge",
    ]);
  });

  it("fails closed unless experimental routes are explicitly enabled", () => {
    expect(experimentalRoutesEnabled(undefined)).toBe(false);
    expect(experimentalRoutesEnabled("0")).toBe(false);
    expect(experimentalRoutesEnabled("true")).toBe(false);
    expect(experimentalRoutesEnabled("1")).toBe(true);
  });

  it("keeps every signed-in product section released while hiding public previews", () => {
    expect(isExperimentalReleasePath("/app/autopilot/month")).toBe(false);
    expect(stableReleaseRedirect("/app/autopilot/month")).toBeNull();
    expect(isExperimentalReleasePath("/variants")).toBe(true);
    expect(stableReleaseRedirect("/variants")).toBe("/");
    expect(stableReleaseRedirect("/app/composer")).toBeNull();
    expect(stableReleaseRedirect("/app/settings")).toBeNull();
  });

  it("keeps only the bot connection page stable inside the experimental bot prefix", () => {
    expect(isExperimentalReleasePath("/bot/connect")).toBe(false);
    expect(stableReleaseRedirect("/bot/connect")).toBeNull();
    expect(isExperimentalReleasePath("/bot")).toBe(true);
    expect(stableReleaseRedirect("/bot")).toBe("/");
    expect(isExperimentalReleasePath("/bot/miniapp")).toBe(true);
    expect(stableReleaseRedirect("/bot/miniapp")).toBe("/");
  });

  it("keeps APIs for released product sections available", () => {
    expect(isExperimentalReleaseApiPath("/api/autopilot/approve")).toBe(false);
    expect(isExperimentalReleasePath("/api/channels/connect-vk")).toBe(false);
    expect(isExperimentalReleaseApiPath("/api/onboarding/progress")).toBe(false);
    expect(isExperimentalReleaseApiPath("/api/autopilot/brief")).toBe(false);
    expect(isExperimentalReleaseApiPath("/api/autopilot/brief/suggest")).toBe(false);
    expect(isExperimentalReleaseApiPath("/api/knowledge/extract-profile")).toBe(false);
    expect(isExperimentalReleaseApiPath("/api/drafts/41")).toBe(false);
    expect(isExperimentalReleaseApiPath("/api/publication-operations")).toBe(false);
  });
});
