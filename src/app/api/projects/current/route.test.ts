import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  checkRateLimit: vi.fn(),
  requireSelectedProjectPermission: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: vi.fn(),
}));
vi.mock("@/lib/project-permissions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/project-permissions")>(),
  requireSelectedProjectPermission: mocks.requireSelectedProjectPermission,
}));

import { PATCH } from "./route";

function request(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/projects/current", {
    method: "PATCH",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/projects/current", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.checkRateLimit.mockResolvedValue({ allowed: true });
    mocks.requireSelectedProjectPermission.mockResolvedValue({ projectId: 12 });
    mocks.query.mockResolvedValue({ rows: [{ id: "12", name: "Новый проект", timezone: "Europe/Saratov" }] });
  });

  it("updates only the selected manageable project", async () => {
    const response = await PATCH(request({ name: "Новый проект", timezone: "Europe/Saratov" }));

    expect(response.status).toBe(200);
    expect(mocks.requireSelectedProjectPermission).toHaveBeenCalledWith(expect.anything(), 7, "project.manage");
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("where id = $1 and is_archived = false"),
      [12, "Новый проект", "Europe/Saratov"],
    );
  });

  it("rejects invalid values before the project update", async () => {
    const response = await PATCH(request({ name: "", timezone: "Mars/Olympus" }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
