import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ getSessionUser: vi.fn(), hasAuroraAdminAccess: vi.fn(), loadAdminAudit: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/admin-access", () => ({ hasAuroraAdminAccess: mocks.hasAuroraAdminAccess }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: vi.fn() }) }));
vi.mock("@/lib/admin-audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin-audit")>()),
  loadAdminAudit: mocks.loadAdminAudit,
}));

import { GET } from "./route";

describe("GET /api/admin/audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 3 });
    mocks.hasAuroraAdminAccess.mockReturnValue(true);
  });

  it("is admin-only and forwards a normalised query", async () => {
    mocks.hasAuroraAdminAccess.mockReturnValue(false);
    expect((await GET(new NextRequest("http://localhost/api/admin/audit"))).status).toBe(403);
    mocks.hasAuroraAdminAccess.mockReturnValue(true);
    mocks.loadAdminAudit.mockResolvedValue({ items: [], pagination: { total: 0 } });
    const response = await GET(new NextRequest("http://localhost/api/admin/audit?area=publication&page=3&actor=9"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.loadAdminAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ area: "publication", page: 3, actorId: 9 }));
  });
});
