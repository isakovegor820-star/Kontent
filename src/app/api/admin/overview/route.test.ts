import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  hasAuroraAdminAccess: vi.fn(),
  loadAdminDashboard: vi.fn(),
  probeRedisAndPublicationWorker: vi.fn(),
  probeAiConfiguration: vi.fn(),
  aiProviderHealthSnapshot: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/admin-access", () => ({ hasAuroraAdminAccess: mocks.hasAuroraAdminAccess }));
vi.mock("@/lib/admin-dashboard", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/admin-dashboard")>();
  return { ...original, loadAdminDashboard: mocks.loadAdminDashboard };
});
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: vi.fn() }) }));
vi.mock("@/lib/readiness-probes", () => ({
  probeRedisAndPublicationWorker: mocks.probeRedisAndPublicationWorker,
  probeAiConfiguration: mocks.probeAiConfiguration,
}));
vi.mock("@/lib/ai-provider-health", () => ({
  aiProviderHealthSnapshot: mocks.aiProviderHealthSnapshot,
}));

import { GET } from "./route";

const dashboard = {
  periodDays: 7,
  summary: {},
  daily: [],
  providers: [],
  attention: [],
  recentUsers: [],
  audit: [],
};

describe("GET /api/admin/overview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.probeRedisAndPublicationWorker.mockResolvedValue({ redis: "up", publicationWorker: "up" });
    mocks.probeAiConfiguration.mockReturnValue(true);
    mocks.aiProviderHealthSnapshot.mockReturnValue([{ state: "closed", lastOutcome: "success" }]);
  });

  it("requires a live session", async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    const response = await GET(new NextRequest("http://localhost/api/admin/overview"));
    expect(response.status).toBe(401);
    expect(mocks.hasAuroraAdminAccess).not.toHaveBeenCalled();
  });

  it("does not query cross-project data for a regular project owner", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: 7, email: "owner@example.com" });
    mocks.hasAuroraAdminAccess.mockReturnValue(false);
    const response = await GET(new NextRequest("http://localhost/api/admin/overview"));
    expect(response.status).toBe(403);
    expect(mocks.loadAdminDashboard).not.toHaveBeenCalled();
  });

  it("returns live admin data with a bounded period and no-store caching", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: 7, email: "admin@example.com" });
    mocks.hasAuroraAdminAccess.mockReturnValue(true);
    mocks.loadAdminDashboard.mockResolvedValue({ ...dashboard, periodDays: 30 });

    const response = await GET(new NextRequest("http://localhost/api/admin/overview?days=30"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      periodDays: 30,
      system: { database: "up", redis: "up", publicationWorker: "up", ai: "healthy" },
    });
    expect(mocks.loadAdminDashboard).toHaveBeenCalledWith(expect.anything(), 30);
  });

  it("reports an unobserved configured AI provider honestly", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: 7, email: "admin@example.com" });
    mocks.hasAuroraAdminAccess.mockReturnValue(true);
    mocks.loadAdminDashboard.mockResolvedValue(dashboard);
    mocks.aiProviderHealthSnapshot.mockReturnValue([]);

    const response = await GET(new NextRequest("http://localhost/api/admin/overview"));
    await expect(response.json()).resolves.toMatchObject({ system: { ai: "unobserved" } });
  });
});
