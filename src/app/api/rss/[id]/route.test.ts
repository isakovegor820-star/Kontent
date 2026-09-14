import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  requireProjectPermission: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
  getJob: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/project-permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-permissions")>();
  return { ...actual, requireProjectPermission: mocks.requireProjectPermission };
});
vi.mock("@/lib/db", () => ({ getPool: () => ({ connect: mocks.connect }) }));
vi.mock("@/lib/queue", () => ({
  getPublishQueue: () => ({ getJob: mocks.getJob }),
  jobIdForPost: (postId: number) => `post-${postId}`,
}));

import { DELETE } from "./route";

function request() {
  return new NextRequest("http://localhost/api/rss/41", {
    method: "DELETE",
    headers: { origin: "http://localhost" },
  });
}

describe("DELETE /api/rss/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.requireProjectPermission.mockResolvedValue({ projectId: 12 });
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("select channel.project_id")) {
        return { rows: [{ project_id: "12" }], rowCount: 1 };
      }
      if (sql.includes("select p.id as post_id")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });
  });

  it("authorizes the feed project instead of trusting its original creator", async () => {
    const response = await DELETE(request(), { params: Promise.resolve({ id: "41" }) });

    expect(response.status).toBe(200);
    expect(mocks.requireProjectPermission).toHaveBeenCalledWith(
      expect.anything(),
      7,
      12,
      "content.publish",
    );
    expect(mocks.query.mock.calls.some(([sql]) =>
      String(sql).includes("channel.project_id = $2"))).toBe(true);
  });

  it("does not cancel posts after project access has been revoked", async () => {
    const { ProjectAccessError } = await import("@/lib/project-permissions");
    mocks.requireProjectPermission.mockRejectedValueOnce(new ProjectAccessError("membership_required"));

    const response = await DELETE(request(), { params: Promise.resolve({ id: "41" }) });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "access_denied" });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("delete from posts"))).toBe(false);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("delete from rss_feeds"))).toBe(false);
  });
});
