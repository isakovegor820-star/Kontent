import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  hasAuroraAdminAccess: vi.fn(),
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(),
  loadAdminSystemDiagnostics: vi.fn(),
  recordAdminObservation: vi.fn(),
  pool: { query: vi.fn() },
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/admin-access", () => ({ hasAuroraAdminAccess: mocks.hasAuroraAdminAccess }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: mocks.rateLimitResponse,
}));
vi.mock("@/lib/admin-system-diagnostics", () => ({
  loadAdminSystemDiagnostics: mocks.loadAdminSystemDiagnostics,
}));
vi.mock("@/lib/admin-observation-audit", () => ({ recordAdminObservation: mocks.recordAdminObservation }));
vi.mock("@/lib/db", () => ({ getPool: () => mocks.pool }));

import { GET } from "./route";

describe("GET /api/admin/system", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7, email: "admin@example.test" });
    mocks.hasAuroraAdminAccess.mockReturnValue(true);
    mocks.checkRateLimit.mockResolvedValue({ allowed: true });
    mocks.loadAdminSystemDiagnostics.mockResolvedValue({
      schemaVersion: 1,
      checkedAt: "2026-08-30T10:00:00.000Z",
      durationMs: 42,
      state: "degraded",
      summary: { total: 2, healthy: 1, configured: 0, warnings: 1, critical: 0 },
      release: { release: null, commitSha: null, deployedAt: null },
      components: [],
    });
    mocks.recordAdminObservation.mockResolvedValue(true);
  });

  it("is admin-only, no-store and rate limited without hiding Redis incidents", async () => {
    const response = await GET(new NextRequest("http://localhost/api/admin/system"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.checkRateLimit).toHaveBeenCalledWith("admin-system:7", 120, 60, { failureMode: "open" });
    expect(mocks.loadAdminSystemDiagnostics).toHaveBeenCalledOnce();
    expect(mocks.recordAdminObservation).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 7,
      action: "admin.system.read",
      targetType: "runtime",
    }));
  });

  it("rejects missing and non-admin sessions before probes", async () => {
    mocks.getSessionUser.mockResolvedValueOnce(null);
    expect((await GET(new NextRequest("http://localhost/api/admin/system"))).status).toBe(401);

    mocks.hasAuroraAdminAccess.mockReturnValueOnce(false);
    expect((await GET(new NextRequest("http://localhost/api/admin/system"))).status).toBe(403);
    expect(mocks.loadAdminSystemDiagnostics).not.toHaveBeenCalled();
  });

  it("returns a no-store limiter response", async () => {
    mocks.checkRateLimit.mockResolvedValueOnce({ allowed: false });
    mocks.rateLimitResponse.mockReturnValueOnce(NextResponse.json({ error: "rate_limited" }, { status: 429 }));
    const response = await GET(new NextRequest("http://localhost/api/admin/system"));
    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.loadAdminSystemDiagnostics).not.toHaveBeenCalled();
  });
});
