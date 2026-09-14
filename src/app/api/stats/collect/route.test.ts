import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  query: vi.fn(),
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(),
  add: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: mocks.rateLimitResponse,
}));
vi.mock("@/lib/queue", () => ({ getStatsQueue: () => ({ add: mocks.add }) }));

import { POST } from "./route";

function request(crossSite = false) {
  return new NextRequest("http://localhost/api/stats/collect", {
    method: "POST",
    headers: crossSite
      ? { origin: "https://attacker.example", "sec-fetch-site": "cross-site" }
      : undefined,
  });
}

describe("POST /api/stats/collect project authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 91 });
    mocks.query.mockResolvedValue({
      rows: [{ project_id: "44", user_id: "91", role: "author", version: "2" }],
      rowCount: 1,
    });
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 2, resetAt: Date.now() + 60_000 });
    mocks.add.mockResolvedValue({ id: "stats-collect-44" });
  });

  it("checks origin before session, project, rate limit, or queue", async () => {
    const response = await POST(request(true));

    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("queues a project-bound collection job for a project member", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith("stats-collect:44:91", 3, 60);
    expect(mocks.add).toHaveBeenCalledWith(
      "collect",
      { userId: 91, projectId: 44 },
      expect.objectContaining({ jobId: "stats-collect-44" }),
    );
  });

  it("does not rate-limit or queue when selected-project membership is missing", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await POST(request());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "access_denied" });
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });
});
