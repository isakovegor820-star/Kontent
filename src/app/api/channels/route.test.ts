import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));

import { GET } from "./route";

function membership(projectId = 44, role = "author") {
  return {
    rows: [{ project_id: String(projectId), user_id: "91", role, version: "2" }],
    rowCount: 1,
  };
}

describe("GET /api/channels project isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 91 });
  });

  it("returns 401 before querying project data for an expired session", async () => {
    mocks.getSessionUser.mockResolvedValueOnce(null);

    const response = await GET(new NextRequest("http://localhost/api/channels"));

    expect(response.status).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("lets a team member read every channel in the selected project only", async () => {
    mocks.query
      .mockResolvedValueOnce(membership())
      .mockResolvedValueOnce({
        rows: [{
          id: "73",
          network: "tg",
          title: "Практика банкротства",
          handle: "bankruptcy_law",
          is_active: true,
          status: "active",
          last_auth_error_code: null,
          last_auth_error_at: null,
        }],
        rowCount: 1,
      });

    const response = await GET(new NextRequest("http://localhost/api/channels"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      channels: [{ id: 73, title: "Практика банкротства" }],
    });
    expect(mocks.query).toHaveBeenCalledTimes(2);
    const [authorizationSql, authorizationParams] = mocks.query.mock.calls[0];
    expect(String(authorizationSql)).toContain("user_project_preferences");
    expect(authorizationParams).toEqual([91]);
    const [dataSql, dataParams] = mocks.query.mock.calls[1];
    expect(String(dataSql)).toContain("where project_id = $1");
    expect(String(dataSql)).not.toContain("where user_id = $1");
    expect(dataParams).toEqual([44]);
  });

  it("fails closed when the server-owned project selection has no active membership", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await GET(new NextRequest("http://localhost/api/channels"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "access_denied" });
    expect(mocks.query).toHaveBeenCalledOnce();
  });
});
