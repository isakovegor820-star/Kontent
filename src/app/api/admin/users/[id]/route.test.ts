import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  hasAuroraAdminAccess: vi.fn(),
  loadAdminUserDetail: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/admin-access", () => ({ hasAuroraAdminAccess: mocks.hasAuroraAdminAccess }));
vi.mock("@/lib/admin-users", () => ({ loadAdminUserDetail: mocks.loadAdminUserDetail }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: vi.fn() }) }));

import { GET } from "./route";

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/admin/users/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 1, email: "admin@example.com" });
    mocks.hasAuroraAdminAccess.mockReturnValue(true);
  });

  it("rejects invalid ids before querying the database", async () => {
    const response = await GET(new NextRequest("http://localhost/api/admin/users/nope"), context("nope"));
    expect(response.status).toBe(400);
    expect(mocks.loadAdminUserDetail).not.toHaveBeenCalled();
  });

  it("returns 404 for a removed account", async () => {
    mocks.loadAdminUserDetail.mockResolvedValue(null);
    const response = await GET(new NextRequest("http://localhost/api/admin/users/91"), context("91"));
    expect(response.status).toBe(404);
  });

  it("loads a bounded period without caching", async () => {
    mocks.loadAdminUserDetail.mockResolvedValue({ user: { id: 7 } });
    const response = await GET(new NextRequest("http://localhost/api/admin/users/7?days=30"), context("7"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.loadAdminUserDetail).toHaveBeenCalledWith(expect.anything(), 7, 30);
  });
});
