import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  hasAuroraAdminAccess: vi.fn(),
  loadAdminUsers: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/admin-access", () => ({ hasAuroraAdminAccess: mocks.hasAuroraAdminAccess }));
vi.mock("@/lib/admin-users", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/admin-users")>();
  return { ...original, loadAdminUsers: mocks.loadAdminUsers };
});
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: vi.fn() }) }));

import { GET } from "./route";

describe("GET /api/admin/users", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires a live admin session before reading cross-project accounts", async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    const response = await GET(new NextRequest("http://localhost/api/admin/users"));
    expect(response.status).toBe(401);
    expect(mocks.loadAdminUsers).not.toHaveBeenCalled();
  });

  it("rejects a regular project owner", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: 4, email: "owner@example.com" });
    mocks.hasAuroraAdminAccess.mockReturnValue(false);
    const response = await GET(new NextRequest("http://localhost/api/admin/users"));
    expect(response.status).toBe(403);
    expect(mocks.loadAdminUsers).not.toHaveBeenCalled();
  });

  it("returns a normalized, uncached account result", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: 1, email: "admin@example.com" });
    mocks.hasAuroraAdminAccess.mockReturnValue(true);
    mocks.loadAdminUsers.mockResolvedValue({ users: [], pagination: { total: 0 } });

    const response = await GET(new NextRequest("http://localhost/api/admin/users?days=30&status=attention&sort=posts_desc"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.loadAdminUsers).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      days: 30,
      status: "attention",
      sort: "posts_desc",
    }));
  });
});
