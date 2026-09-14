import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => {
  const client = {
    query: vi.fn(),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn(),
    connect: vi.fn(async () => client),
  };
  return {
    client,
    pool,
    getSessionUser: vi.fn(),
    requireSelectedProjectPermission: vi.fn(),
    getJob: vi.fn(),
    removeJob: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({ getPool: () => mocks.pool }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: () => true }));
vi.mock("@/lib/project-permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-permissions")>();
  return { ...actual, requireSelectedProjectPermission: mocks.requireSelectedProjectPermission };
});
vi.mock("@/lib/queue", () => ({
  getPublishQueue: () => ({ getJob: mocks.getJob }),
  jobIdForPost: (postId: string | number) => `post-${postId}`,
  jobIdForPostRevision: (postId: string | number, revision: string | number) => `post-${postId}-r${revision}`,
}));

import { PATCH } from "./route";

function request(enabled: boolean) {
  return new NextRequest("http://localhost/api/rss/auto-publish", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channelId: 7, enabled }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getSessionUser.mockResolvedValue({ id: 5 });
  mocks.requireSelectedProjectPermission.mockResolvedValue({ projectId: 17, userId: 5, role: "owner" });
  mocks.pool.query.mockResolvedValue({ rows: [{ id: "7" }], rowCount: 1 });
  mocks.getJob.mockResolvedValue({ remove: mocks.removeJob });
  mocks.removeJob.mockResolvedValue(undefined);
});

describe("PATCH /api/rss/auto-publish", () => {
  it("enables only future legal opportunities after baselining collected items", async () => {
    mocks.client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("from rss_feeds") && sql.includes("for update")) {
        return { rows: [{ id: "1" }, { id: "2" }], rowCount: 2 };
      }
      return { rows: [], rowCount: 1 };
    });

    const response = await PATCH(request(true));

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      autoPublishEnabled: true,
      cancelled: 0,
    });
    expect(mocks.requireSelectedProjectPermission).toHaveBeenCalledWith(mocks.pool, 5, "content.publish");
    expect(mocks.client.query).toHaveBeenCalledWith(
      expect.stringContaining("skip_reason = 'baseline'"),
      [["1", "2"]],
    );
    expect(mocks.client.query).toHaveBeenCalledWith(
      expect.stringContaining("set auto_publish_enabled = true"),
      [["1", "2"]],
    );
    expect(mocks.getJob).not.toHaveBeenCalled();
  });

  it("disables publication and cancels every not-yet-delivered RSS post", async () => {
    mocks.client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("from rss_feeds") && sql.includes("for update")) {
        return { rows: [{ id: "1" }], rowCount: 1 };
      }
      if (sql.includes("select p.id as post_id")) {
        return {
          rows: [{ post_id: "43", item_id: "291", schedule_revision: "2" }],
          rowCount: 1,
        };
      }
      if (sql.includes("count(distinct p.id)")) {
        return { rows: [{ count: "0" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    const response = await PATCH(request(false));

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      autoPublishEnabled: false,
      cancelled: 1,
      publishingNow: 0,
    });
    expect(mocks.client.query).toHaveBeenCalledWith(
      expect.stringContaining("set auto_publish_enabled = false"),
      [5, 7],
    );
    expect(mocks.client.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'cancelled'"),
      [["43"]],
    );
    expect(mocks.client.query).toHaveBeenCalledWith(
      expect.stringContaining("skip_reason = 'paused'"),
      [["291"]],
    );
    expect(mocks.getJob).toHaveBeenCalledWith("post-43");
    expect(mocks.getJob).toHaveBeenCalledWith("post-43-r2");
    expect(mocks.removeJob).toHaveBeenCalledTimes(2);
  });
});
