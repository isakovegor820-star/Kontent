import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  hasTrustedMutationOrigin: vi.fn(),
  query: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  requireSelectedProjectPermission: vi.fn(),
  verifySiteOwnership: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: mocks.hasTrustedMutationOrigin }));
vi.mock("@/lib/db", () => ({
  getPool: () => ({
    query: mocks.query,
    connect: async () => ({ query: mocks.clientQuery, release: mocks.release }),
  }),
}));
vi.mock("@/lib/project-permissions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/project-permissions")>(),
  requireSelectedProjectPermission: mocks.requireSelectedProjectPermission,
}));
vi.mock("@/lib/sites/verification", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/sites/verification")>(),
  verifySiteOwnership: mocks.verifySiteOwnership,
}));

import { POST } from "./route";

const siteRow = {
  id: "5",
  project_id: "31",
  user_id: "7",
  confirmed_domain: "example.ru",
  canonical_url: "https://example.ru/",
  verification_state: "unverified",
  verification_method: null,
  verification_token: "abcdefghijklmnopqrstuvwxyz0123456789_-AB",
  verified_at: null,
  latest_analysis_id: null,
  latest_profile_id: null,
  publishing_mode: "confirm",
  auto_unlock_streak: 10,
  approved_streak: 0,
  cadence: {},
  status: "active",
  created_at: new Date("2026-09-01T00:00:00Z"),
  updated_at: new Date("2026-09-01T00:00:00Z"),
};

function post(id: string, body: Record<string, unknown> = {}) {
  return new NextRequest(`http://localhost/api/sites/${id}/verify`, {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const context = (id: string) => ({ params: Promise.resolve({ id }) });

describe("POST /api/sites/:id/verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.hasTrustedMutationOrigin.mockReturnValue(true);
    mocks.requireSelectedProjectPermission.mockResolvedValue({ projectId: 31, userId: 7, role: "owner", version: 1 });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("from sites where id = $1 and project_id = $2")) return { rows: [siteRow] };
      return { rows: [] };
    });
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("update sites")) return { rows: [{ ...siteRow, verification_state: "verified", verification_method: "dns_txt", verified_at: new Date() }] };
      return { rows: [] };
    });
  });

  it("hides sites from other projects and rejects unknown methods", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    expect((await POST(post("5"), context("5"))).status).toBe(404);
    expect((await POST(post("5", { method: "carrier_pigeon" }), context("5"))).status).toBe(400);
    expect((await POST(post("abc"), context("abc"))).status).toBe(400);
    expect(mocks.verifySiteOwnership).not.toHaveBeenCalled();
  });

  it("reports an unverified outcome without touching the database", async () => {
    mocks.verifySiteOwnership.mockResolvedValueOnce({ ok: false, method: "dns_txt", reason: "dns_txt_missing" });
    const response = await POST(post("5"), context("5"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ verified: false, reason: "dns_txt_missing", method: "dns_txt" });
    expect(body.site.verification.state).toBe("unverified");
    expect(mocks.clientQuery).not.toHaveBeenCalled();
    expect(mocks.verifySiteOwnership).toHaveBeenCalledWith(
      { confirmedDomain: "example.ru", canonicalUrl: "https://example.ru/", verificationToken: siteRow.verification_token },
      "auto",
    );
  });

  it("marks the site verified in a transaction and writes an audit event", async () => {
    mocks.verifySiteOwnership.mockResolvedValueOnce({ ok: true, method: "dns_txt" });
    const response = await POST(post("5", { method: "dns_txt" }), context("5"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ verified: true, replayed: false, method: "dns_txt" });
    expect(body.site.verification).toMatchObject({ state: "verified", method: "dns_txt" });
    const sql = mocks.clientQuery.mock.calls.map(([statement]) => String(statement));
    expect(sql[0]).toBe("begin");
    expect(sql.find((statement) => statement.includes("update sites"))).toContain("verification_state <> 'verified'");
    const audit = mocks.clientQuery.mock.calls.find(([statement]) => String(statement).includes("insert into audit_events"));
    expect(audit?.[1]).toEqual([31, 7, "5", JSON.stringify({ domain: "example.ru", method: "dns_txt" }), expect.any(String), "site-verified:31:5"]);
    expect(sql.at(-1)).toBe("commit");
    expect(mocks.release).toHaveBeenCalled();
  });

  it("is idempotent for an already verified site", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ ...siteRow, verification_state: "verified", verification_method: "meta_tag" }] });
    const response = await POST(post("5"), context("5"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ verified: true, replayed: true });
    expect(mocks.verifySiteOwnership).not.toHaveBeenCalled();
    expect(mocks.clientQuery).not.toHaveBeenCalled();
  });
});
