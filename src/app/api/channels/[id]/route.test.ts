import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  requireProjectPermission: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/project-permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-permissions")>();
  return { ...actual, requireProjectPermission: mocks.requireProjectPermission };
});
vi.mock("@/lib/db", () => ({ getPool: () => ({ connect: mocks.connect }) }));

import { DELETE } from "./route";

function request() {
  return new NextRequest("http://localhost/api/channels/41", {
    method: "DELETE",
    headers: {
      origin: "http://localhost",
      "idempotency-key": "disconnect-channel-41",
    },
  });
}

describe("DELETE /api/channels/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.requireProjectPermission.mockResolvedValue({ projectId: 12 });
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("select id, project_id, status")) {
        return {
          rows: [{ id: "41", project_id: "12", status: "active", oauth_token_id: null }],
          rowCount: 1,
        };
      }
      if (sql.includes("from channel_events")) return { rows: [], rowCount: 0 };
      if (sql.includes("from posts")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });
  });

  it("lets a current project manager disconnect a channel created by another member", async () => {
    const response = await DELETE(request(), { params: Promise.resolve({ id: "41" }) });

    expect(response.status).toBe(200);
    expect(mocks.requireProjectPermission).toHaveBeenCalledWith(
      expect.anything(),
      7,
      12,
      "project.manage",
    );
  });

  it("blocks the original connector after their membership is revoked", async () => {
    const { ProjectAccessError } = await import("@/lib/project-permissions");
    mocks.requireProjectPermission.mockRejectedValueOnce(new ProjectAccessError("membership_required"));

    const response = await DELETE(request(), { params: Promise.resolve({ id: "41" }) });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "access_denied" });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("update channels"))).toBe(false);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("insert into channel_events"))).toBe(false);
  });
});
