import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));

import { GET } from "./route";

describe("GET /api/stats availability", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 instead of an empty-account success for an expired session", async () => {
    mocks.getSessionUser.mockResolvedValueOnce(null);

    const response = await GET(new NextRequest("http://localhost/api/stats?channel=1"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      hasChannel: false,
      error: "unauthorized",
    });
  });

  it("returns 503 instead of pretending that a PostgreSQL outage means no channel", async () => {
    mocks.getSessionUser.mockResolvedValueOnce({ id: 7 });
    mocks.query.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await GET(new NextRequest("http://localhost/api/stats?channel=1"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      hasChannel: false,
      error: "stats_unavailable",
    });
  });
});
