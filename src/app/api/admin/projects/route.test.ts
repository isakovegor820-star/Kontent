import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  hasAuroraAdminAccess: vi.fn(),
  loadAdminProjects: vi.fn(),
  loadAdminProjectDetail: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/admin-access", () => ({ hasAuroraAdminAccess: mocks.hasAuroraAdminAccess }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: vi.fn() }) }));
vi.mock("@/lib/admin-projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin-projects")>()),
  loadAdminProjects: mocks.loadAdminProjects,
  loadAdminProjectDetail: mocks.loadAdminProjectDetail,
}));

import { GET as listProjects } from "./route";
import { GET as projectDetail } from "./[id]/route";

describe("admin projects API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 3, email: "admin@example.com" });
    mocks.hasAuroraAdminAccess.mockReturnValue(true);
  });

  it("is admin-only and never leaks to project owners", async () => {
    mocks.hasAuroraAdminAccess.mockReturnValue(false);
    expect((await listProjects(new NextRequest("http://localhost/api/admin/projects"))).status).toBe(403);
    expect((await projectDetail(new NextRequest("http://localhost/api/admin/projects/5"), { params: Promise.resolve({ id: "5" }) })).status).toBe(403);
    expect(mocks.loadAdminProjects).not.toHaveBeenCalled();
    expect(mocks.loadAdminProjectDetail).not.toHaveBeenCalled();
  });

  it("normalises the list query and returns a no-store payload", async () => {
    mocks.loadAdminProjects.mockResolvedValue({ projects: [], pagination: { total: 0 } });
    const response = await listProjects(new NextRequest("http://localhost/api/admin/projects?days=30&status=attention&page=2&sort=bad"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.loadAdminProjects).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ days: 30, status: "attention", page: 2, sort: "activity_desc" }));
  });

  it("validates the project id and maps a missing project to 404", async () => {
    expect((await projectDetail(new NextRequest("http://localhost/api/admin/projects/x"), { params: Promise.resolve({ id: "x" }) })).status).toBe(400);
    mocks.loadAdminProjectDetail.mockResolvedValue(null);
    expect((await projectDetail(new NextRequest("http://localhost/api/admin/projects/9"), { params: Promise.resolve({ id: "9" }) })).status).toBe(404);
    mocks.loadAdminProjectDetail.mockResolvedValue({ project: { id: 9 } });
    const ok = await projectDetail(new NextRequest("http://localhost/api/admin/projects/9?days=30"), { params: Promise.resolve({ id: "9" }) });
    expect(ok.status).toBe(200);
    expect(mocks.loadAdminProjectDetail).toHaveBeenLastCalledWith(expect.anything(), 9, 30);
  });
});
