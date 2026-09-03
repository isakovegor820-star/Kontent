import { describe, expect, it } from "vitest";

import { normalizeAdminProjectsQuery } from "./admin-projects";

describe("admin projects query normalisation", () => {
  it("falls back to safe defaults and bounds every filter", () => {
    expect(normalizeAdminProjectsQuery(new URLSearchParams(""))).toEqual({
      days: 7, query: "", status: "all", network: "all", sort: "activity_desc", page: 1, pageSize: 25,
    });
    expect(normalizeAdminProjectsQuery(new URLSearchParams("days=30&q=FitLab&status=attention&network=tg&sort=posts_desc&page=2")))
      .toEqual({ days: 30, query: "FitLab", status: "attention", network: "tg", sort: "posts_desc", page: 2, pageSize: 25 });
    expect(normalizeAdminProjectsQuery(new URLSearchParams("days=90&status=drop%20table&network=vk;--&sort=x&page=0")))
      .toEqual({ days: 7, query: "", status: "all", network: "all", sort: "activity_desc", page: 1, pageSize: 25 });
  });
});
