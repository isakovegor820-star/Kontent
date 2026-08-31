import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  hasAuroraAdminAccess: vi.fn(),
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(),
  loadAdminAuroraAnalytics: vi.fn(),
  recordAdminObservation: vi.fn(),
  pool: { query: vi.fn() },
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/admin-access", () => ({ hasAuroraAdminAccess: mocks.hasAuroraAdminAccess }));
vi.mock("@/lib/db", () => ({ getPool: () => mocks.pool }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: mocks.rateLimitResponse,
}));
vi.mock("@/lib/product-events", () => ({ productEventRetentionDays: () => 90 }));
vi.mock("@/lib/admin-observation-audit", () => ({ recordAdminObservation: mocks.recordAdminObservation }));
vi.mock("@/lib/admin-aurora-analytics", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/admin-aurora-analytics")>();
  return { ...original, loadAdminAuroraAnalytics: mocks.loadAdminAuroraAnalytics };
});

import { GET } from "./route";

describe("GET /api/admin/aurora-analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7, email: "admin@example.test" });
    mocks.hasAuroraAdminAccess.mockReturnValue(true);
    mocks.checkRateLimit.mockResolvedValue({ allowed: true });
    mocks.loadAdminAuroraAnalytics.mockResolvedValue({ schemaVersion: 1, sections: [] });
    mocks.recordAdminObservation.mockResolvedValue(true);
  });

  it("is admin-only and never queries analytics for a project owner", async () => {
    mocks.hasAuroraAdminAccess.mockReturnValue(false);
    const response = await GET(new NextRequest("http://localhost/api/admin/aurora-analytics"));
    expect(response.status).toBe(403);
    expect(mocks.loadAdminAuroraAnalytics).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("uses a fail-closed limiter, normalized filters, no-store and a content-free audit", async () => {
    const response = await GET(new NextRequest("http://localhost/api/admin/aurora-analytics?project=42&analyticsSection=studio&analyticsTab=funnel"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith("admin-aurora-analytics:7", 60, 60, { failureMode: "closed" });
    expect(mocks.loadAdminAuroraAnalytics).toHaveBeenCalledWith(mocks.pool, expect.objectContaining({
      projectId: 42, sectionId: "studio", tab: "funnel",
    }), { rawRetentionDays: 90 });
    expect(mocks.recordAdminObservation).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 7, targetType: "section", targetId: "studio",
    }));
  });

  it("rejects invalid filters before database access", async () => {
    const response = await GET(new NextRequest("http://localhost/api/admin/aurora-analytics?device=phone"));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: "analytics_device_invalid" });
    expect(mocks.loadAdminAuroraAnalytics).not.toHaveBeenCalled();
  });

  it("returns a no-store limiter response", async () => {
    mocks.checkRateLimit.mockResolvedValue({ allowed: false });
    mocks.rateLimitResponse.mockReturnValue(NextResponse.json({ error: "rate_limited" }, { status: 429 }));
    const response = await GET(new NextRequest("http://localhost/api/admin/aurora-analytics"));
    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.loadAdminAuroraAnalytics).not.toHaveBeenCalled();
  });
});
