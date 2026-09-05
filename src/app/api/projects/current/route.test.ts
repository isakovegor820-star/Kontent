import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  checkRateLimit: vi.fn(),
  requireSelectedProjectPermission: vi.fn(),
  query: vi.fn(),
  selectProjectForUser: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query, connect: async()=>({
  query: async(sql:string,values?:unknown[])=>{
    if (["begin","commit","rollback"].includes(sql) || sql.startsWith("set local")) return {rows:[],rowCount:0};
    if (sql.startsWith("select id from projects")) return {rows:[{id:12}],rowCount:1};
    if (sql.startsWith("select role, version from project_members")) return {rows:[{role:"owner",version:4}],rowCount:1};
    if (sql.startsWith("select id from users")) return {rows:[{id:7}],rowCount:1};
    return mocks.query(sql,values);
  },release:vi.fn(),
}) }) }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: vi.fn(),
}));
vi.mock("@/lib/project-permissions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/project-permissions")>(),
  requireSelectedProjectPermission: mocks.requireSelectedProjectPermission,
}));

vi.mock("@/lib/project-context", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/project-context")>(),
  selectProjectForUser: mocks.selectProjectForUser,
}));

import { PATCH, PUT } from "./route";
import { parseClientProject } from "@/lib/project-client";

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


describe("project selection browser contract", () => {
  it("returns the selected context in the shape consumed by the project switcher", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.checkRateLimit.mockResolvedValue({ allowed: true });
    mocks.selectProjectForUser.mockResolvedValue({ projectId: 12, name: "Other project", timezone: "UTC", role: "owner", version: 2, personal: false });
    const response = await PUT(new NextRequest("http://localhost/api/projects/current", {
      method: "PUT", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ projectId: 12 }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.project.projectId).toBe(12);
    expect(parseClientProject(body.project)).toMatchObject({ id: 12, name: "Other project", selected: true });
  });
});
