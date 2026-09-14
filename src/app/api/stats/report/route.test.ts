import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  query: vi.fn(),
  add: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/queue", () => ({ getStatsQueue: () => ({ add: mocks.add }) }));

import { POST } from "./route";

function request(crossSite = false) {
  return new NextRequest("http://localhost/api/stats/report", {
    method: "POST",
    headers: crossSite
      ? { origin: "https://attacker.example", "sec-fetch-site": "cross-site" }
      : undefined,
  });
}

describe("POST /api/stats/report project authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 91 });
    mocks.query.mockResolvedValue({
      rows: [{ project_id: "44", user_id: "91", role: "publisher", version: "4" }],
      rowCount: 1,
    });
    mocks.add.mockResolvedValue({ id: "report-44-91" });
  });

  it("checks origin before authentication and side effects", async () => {
    const response = await POST(request(true));

    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("queues a report with both actor and selected project", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.add).toHaveBeenCalledWith(
      "report",
      { userId: 91, projectId: 44 },
      expect.objectContaining({ jobId: "report-44-91", attempts: 3 }),
    );
  });

  it("does not queue a report for a former project member", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await POST(request());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "access_denied" });
    expect(mocks.add).not.toHaveBeenCalled();
  });
});
