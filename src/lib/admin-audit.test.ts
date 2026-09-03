import { describe, expect, it } from "vitest";

import { normalizeAdminAuditQuery } from "./admin-audit";

describe("admin audit query normalisation", () => {
  it("bounds every filter and ignores unsafe areas", () => {
    expect(normalizeAdminAuditQuery(new URLSearchParams(""))).toEqual({ query: "", projectId: null, actorId: null, area: "", page: 1, pageSize: 50 });
    expect(normalizeAdminAuditQuery(new URLSearchParams("q=4302&project=12&actor=3&area=publication&page=2")))
      .toEqual({ query: "4302", projectId: 12, actorId: 3, area: "publication", page: 2, pageSize: 50 });
    expect(normalizeAdminAuditQuery(new URLSearchParams("area=drop%20table&project=x&page=0")))
      .toEqual({ query: "", projectId: null, actorId: null, area: "", page: 1, pageSize: 50 });
  });
});
