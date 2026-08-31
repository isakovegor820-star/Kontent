import { describe, expect, it } from "vitest";

import {
  adminAnalyticsHref,
  adminAnalyticsQuery,
  adminSystemHref,
  adminSystemSelection,
} from "./admin-url-state";

describe("admin system URL state", () => {
  it("accepts only real diagnostic component ids", () => {
    expect(adminSystemSelection("?system=postgresql", ["postgresql", "redis"])).toBe("postgresql");
    expect(adminSystemSelection("?system=private", ["postgresql", "redis"])).toBeNull();
  });

  it("preserves unrelated filters and anchors the System section", () => {
    expect(adminSystemHref("https://aurora.example/admin?days=30#overview", "redis"))
      .toBe("/admin?days=30&system=redis#system");
    expect(adminSystemHref("https://aurora.example/admin?system=redis#system", null))
      .toBe("/admin#system");
  });
});

describe("Aurora analytics URL state", () => {
  it("preserves unrelated state while changing filters and detail tabs", () => {
    expect(adminAnalyticsHref(
      "https://aurora.test/admin?system=redis&range=7d&project=2#system",
      { range: "30d", analyticsSection: "studio", analyticsTab: "funnel" },
    )).toBe("/admin?system=redis&range=30d&project=2&analyticsSection=studio&analyticsTab=funnel#aurora-analytics");
  });

  it("removes all-values and forwards only allowlisted analytics keys to the API", () => {
    const href = adminAnalyticsHref("/admin?range=7d&release=r1&unsafe=secret", { release: "all", device: "mobile" });
    expect(href).toBe("/admin?range=7d&unsafe=secret&device=mobile#aurora-analytics");
    expect(adminAnalyticsQuery(new URL(href, "http://localhost").searchParams).toString()).toBe("range=7d&device=mobile");
  });
});
