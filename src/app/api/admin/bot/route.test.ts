import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  hasAuroraAdminAccess: vi.fn(),
  loadAdminBotData: vi.fn(),
  probeAdminTelegramBot: vi.fn(),
  probeRedisAndPublicationWorker: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/admin-access", () => ({ hasAuroraAdminAccess: mocks.hasAuroraAdminAccess }));
vi.mock("@/lib/admin-bot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin-bot")>()),
  loadAdminBotData: mocks.loadAdminBotData,
  probeAdminTelegramBot: mocks.probeAdminTelegramBot,
}));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: vi.fn() }) }));
vi.mock("@/lib/readiness-probes", () => ({ probeRedisAndPublicationWorker: mocks.probeRedisAndPublicationWorker }));

import { GET } from "./route";

describe("GET /api/admin/bot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadAdminBotData.mockResolvedValue({ periodDays: 7, summary: {}, daily: [], users: [], projects: [], deliveries: [], audit: [] });
    mocks.probeAdminTelegramBot.mockResolvedValue({ state: "healthy", configured: true });
    mocks.probeRedisAndPublicationWorker.mockResolvedValue({
      redis: "up",
      publicationWorker: "up",
      telegramPolling: "up",
    });
  });

  it("requires a live administrator session", async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    const response = await GET(new NextRequest("http://localhost/api/admin/bot"));
    expect(response.status).toBe(401);
    expect(mocks.loadAdminBotData).not.toHaveBeenCalled();
  });

  it("rejects a project owner without platform access", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: 7, email: "owner@example.com" });
    mocks.hasAuroraAdminAccess.mockReturnValue(false);
    const response = await GET(new NextRequest("http://localhost/api/admin/bot"));
    expect(response.status).toBe(403);
    expect(mocks.loadAdminBotData).not.toHaveBeenCalled();
  });

  it("returns a bounded live overview without caching", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: 1, email: "admin@example.com" });
    mocks.hasAuroraAdminAccess.mockReturnValue(true);
    mocks.loadAdminBotData.mockResolvedValue({ periodDays: 30, summary: { linkedUsers: 4 }, daily: [], users: [], projects: [], deliveries: [], audit: [] });
    const response = await GET(new NextRequest("http://localhost/api/admin/bot?days=30"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      periodDays: 30,
      summary: { linkedUsers: 4 },
      runtime: { state: "healthy" },
      workerState: "up",
      publicationWorkerState: "up",
    });
    expect(mocks.loadAdminBotData).toHaveBeenCalledWith(expect.anything(), 30, { query: "", page: 1, pageSize: 20 });
  });
});
