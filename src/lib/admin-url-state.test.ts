import { describe, expect, it } from "vitest";

import {
  adminAnalyticsHref,
  adminAnalyticsQuery,
  adminProjectsHref,
  adminProjectsQuery,
  adminPublicationsApiParams,
  adminPublicationsHref,
  adminPublicationsQuery,
  adminSystemHref,
  adminSystemSelection,
  adminUsersHref,
  adminUsersQuery,
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

describe("admin users URL state", () => {
  it("drops defaults, keeps unrelated params and anchors the Users section", () => {
    expect(adminUsersHref("https://aurora.test/admin?system=redis#system", { q: "ivan", status: "attention", page: 1, sort: "activity_desc" }))
      .toBe("/admin?system=redis&q=ivan&status=attention#users");
    expect(adminUsersHref("/admin?q=ivan&page=3#users", { q: "", page: 1, user: 42 }))
      .toBe("/admin?user=42#users");
    expect(adminUsersHref("/admin?user=42#users", { user: null })).toBe("/admin#users");
  });

  it("parses the query string back into a complete request with defaults", () => {
    expect(adminUsersQuery("?q=ivan&page=2&user=7&unknown=1")).toEqual({
      q: "ivan", status: "all", network: "all", sort: "activity_desc", page: "2", user: "7",
    });
    expect(adminUsersQuery("")).toEqual({ q: "", status: "all", network: "all", sort: "activity_desc", page: "1", user: "" });
  });
});

describe("admin projects URL state", () => {
  it("keeps the open project card in a key that does not collide with the analytics project filter", () => {
    expect(adminProjectsHref("/admin?project=2&range=7d#aurora-analytics", { prid: 12, prstatus: "attention" }))
      .toBe("/admin?project=2&range=7d&prid=12&prstatus=attention#projects");
    expect(adminProjectsQuery("?prid=12&prstatus=attention&project=2"))
      .toEqual({ prq: "", prstatus: "attention", prnetwork: "all", prsort: "activity_desc", prpage: "1", prid: "12" });
  });
});

describe("admin publications URL state", () => {
  it("uses prefixed keys so publications filters coexist with users state", () => {
    expect(adminPublicationsHref("/admin?user=42#users", { pstatus: "failed", pq: "4302", ppage: 1 }))
      .toBe("/admin?user=42&pstatus=failed&pq=4302#publications");
    expect(adminPublicationsHref("/admin?pstatus=failed&ppage=3#publications", { pstatus: "attention", ppage: 1 }))
      .toBe("/admin#publications");
  });

  it("maps URL state onto the API query with safe defaults", () => {
    const state = adminPublicationsQuery("?pq=4302&pnetwork=vk&perror=vk_token_expired&junk=1");
    expect(state).toEqual({ pq: "4302", pstatus: "attention", pnetwork: "vk", pproject: "", perror: "vk_token_expired", psort: "recent", ppage: "1" });
    expect(adminPublicationsApiParams(state).toString())
      .toBe("q=4302&status=attention&network=vk&project=&error=vk_token_expired&sort=recent&page=1");
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
