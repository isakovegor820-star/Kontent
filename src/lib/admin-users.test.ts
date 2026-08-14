import { describe, expect, it } from "vitest";

import { normalizeAdminUsersQuery } from "./admin-users";

describe("admin user query normalization", () => {
  it("uses safe defaults", () => {
    expect(normalizeAdminUsersQuery(new URLSearchParams())).toEqual({
      days: 7,
      query: "",
      status: "all",
      network: "all",
      sort: "activity_desc",
      page: 1,
      pageSize: 25,
    });
  });

  it("accepts supported filters and bounds free-form values", () => {
    const params = new URLSearchParams({
      days: "30",
      query: `  ${"a".repeat(140)}  `,
      status: "attention",
      network: "instagram",
      sort: "posts_desc",
      page: "12",
    });
    const result = normalizeAdminUsersQuery(params);
    expect(result).toMatchObject({
      days: 30,
      status: "attention",
      network: "instagram",
      sort: "posts_desc",
      page: 12,
    });
    expect(result.query).toHaveLength(120);
  });

  it("rejects unsupported enum values and invalid pages", () => {
    const params = new URLSearchParams({
      status: "super-admin",
      network: "unknown",
      sort: "drop-table",
      page: "-4",
    });
    expect(normalizeAdminUsersQuery(params)).toMatchObject({
      status: "all",
      network: "all",
      sort: "activity_desc",
      page: 1,
    });
  });
});
