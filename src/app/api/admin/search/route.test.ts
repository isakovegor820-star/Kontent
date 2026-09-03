import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ getSessionUser: vi.fn(), hasAuroraAdminAccess: vi.fn(), searchAdminEntities: vi.fn(), checkRateLimit: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/admin-access", () => ({ hasAuroraAdminAccess: mocks.hasAuroraAdminAccess }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: vi.fn() }) }));
vi.mock("@/lib/admin-search", () => ({ searchAdminEntities: mocks.searchAdminEntities }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit, rateLimitResponse: () => new Response(null, { status: 429 }) }));

import { GET } from "./route";

describe("GET /api/admin/search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 3 });
    mocks.hasAuroraAdminAccess.mockReturnValue(true);
    mocks.checkRateLimit.mockResolvedValue({ allowed: true });
  });

  it("is admin-only, rate limited and no-store", async () => {
    mocks.hasAuroraAdminAccess.mockReturnValue(false);
    expect((await GET(new NextRequest("http://localhost/api/admin/search?q=igor"))).status).toBe(403);
    mocks.hasAuroraAdminAccess.mockReturnValue(true);
    mocks.checkRateLimit.mockResolvedValueOnce({ allowed: false });
    expect((await GET(new NextRequest("http://localhost/api/admin/search?q=igor"))).status).toBe(429);
    mocks.searchAdminEntities.mockResolvedValue({ query: "igor", users: [], projects: [], posts: [] });
    const response = await GET(new NextRequest("http://localhost/api/admin/search?q=igor"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.searchAdminEntities).toHaveBeenCalledWith(expect.anything(), "igor");
  });
});
