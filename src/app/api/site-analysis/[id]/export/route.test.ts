import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  query: vi.fn(),
  buildSnapshot: vi.fn(),
  renderExport: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/site-analysis/export.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/site-analysis/export.mjs")>();
  return {
    ...actual,
    buildSiteAnalysisExportSnapshot: mocks.buildSnapshot,
    renderSiteAnalysisExport: mocks.renderExport,
  };
});

import { GET } from "./route";

describe("GET /api/site-analysis/:id/export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.query.mockResolvedValue({ rows: [{
      id: 41,
      request_id: "req-41",
      target_url: "https://example.com/",
      confirmed_domain: "example.com",
      run_revision: 2,
      result: { osint: { reportStatus: "complete" } },
      completed_at: "2026-08-05T12:00:00Z",
    }] });
    mocks.buildSnapshot.mockReturnValue({ analysis: { snapshotHash: `sha256:${"a".repeat(64)}` } });
    mocks.renderExport.mockResolvedValue({ bytes: Buffer.from("file"), contentType: "application/json", extension: "json" });
  });

  it("exports only the authenticated user's immutable ready result", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/site-analysis/41/export?format=json"),
      { params: Promise.resolve({ id: "41" }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("aurora-site-osint-41-r2.json");
    expect(response.headers.get("x-aurora-snapshot-hash")).toBe(`sha256:${"a".repeat(64)}`);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("status = 'ready'"), [41, 7]);
  });

  it("fails closed for unauthenticated and unsupported requests", async () => {
    mocks.getSessionUser.mockResolvedValueOnce(null);
    expect((await GET(new NextRequest("http://localhost/api/site-analysis/41/export?format=json"), { params: Promise.resolve({ id: "41" }) })).status).toBe(401);
    mocks.getSessionUser.mockResolvedValueOnce({ id: 7 });
    expect((await GET(new NextRequest("http://localhost/api/site-analysis/41/export?format=xml"), { params: Promise.resolve({ id: "41" }) })).status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
