import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getProductionBrief: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: vi.fn() }) }));
vi.mock("@/lib/legal-video-script-service", () => ({
  getLegalVideoProductionBrief: mocks.getProductionBrief,
}));

import { ProjectAccessError } from "@/lib/project-permissions";
import { GET } from "./route";

const context = { params: Promise.resolve({ id: "201" }) };

function request() {
  return new NextRequest("http://localhost/api/legal-video-scripts/201/production-brief");
}

describe("GET /api/legal-video-scripts/:id/production-brief", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires a session before asking the project-scoped service for the brief", async () => {
    mocks.getSessionUser.mockResolvedValue(null);

    const response = await GET(request(), context);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "unauthorized" });
    expect(mocks.getProductionBrief).not.toHaveBeenCalled();
  });

  it("exports only the authenticated actor's authorized project record as a private attachment", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: 12 });
    mocks.getProductionBrief.mockResolvedValue({
      record: { id: 201, revision: 4 },
      brief: "СЦЕНАРИЙ КОРОТКОГО ВИДЕО\nПроверенный production brief",
    });

    const response = await GET(request(), context);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="legal-video-201-r4.txt"',
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.text()).resolves.toContain("Проверенный production brief");
    expect(mocks.getProductionBrief).toHaveBeenCalledWith({
      pool: expect.anything(),
      actorUserId: 12,
      scriptId: 201,
    });
  });

  it("does not disclose a production brief when selected-project read RBAC rejects", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: 12 });
    mocks.getProductionBrief.mockRejectedValue(new ProjectAccessError("permission_denied"));

    const response = await GET(request(), context);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "access_denied" });
  });
});
