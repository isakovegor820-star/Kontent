import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  requireSelectedProjectPermission: vi.fn(),
  requireProjectPermission: vi.fn(),
  query: vi.fn(),
  add: vi.fn(),
  transitionChannelHealth: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/project-permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-permissions")>();
  return {
    ...actual,
    requireSelectedProjectPermission: mocks.requireSelectedProjectPermission,
    requireProjectPermission: mocks.requireProjectPermission,
  };
});
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/queue", () => ({ getStatsQueue: () => ({ add: mocks.add }) }));
vi.mock("@/lib/channel-health.mjs", () => ({
  transitionChannelHealth: mocks.transitionChannelHealth,
}));

import { POST } from "./route";

const previousToken = process.env.TG_BOT_TOKEN;

function request() {
  return new NextRequest("http://localhost/api/channels/connect", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({ handle: "@team" }),
  });
}

describe("POST /api/channels/connect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TG_BOT_TOKEN = "12345:test-token";
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.requireSelectedProjectPermission.mockResolvedValue({ projectId: 12 });
    mocks.requireProjectPermission.mockResolvedValue({ projectId: 12 });
    mocks.add.mockResolvedValue({ id: "discover" });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("select id from channels")) return { rows: [], rowCount: 0 };
      if (sql.includes("insert into channels")) return { rows: [{ id: 41 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: { id: -1001, title: "Team", username: "team" },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: { status: "administrator", can_post_messages: true },
      }))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousToken === undefined) delete process.env.TG_BOT_TOKEN;
    else process.env.TG_BOT_TOKEN = previousToken;
  });

  it("writes an explicit authorized project instead of relying on the database trigger", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.requireSelectedProjectPermission).toHaveBeenCalledWith(
      expect.anything(),
      7,
      "project.manage",
    );
    const insert = mocks.query.mock.calls.find(([sql]) => String(sql).includes("insert into channels"));
    expect(String(insert?.[0])).toContain("project_id");
    expect(insert?.[1]).toEqual([12, 7, -1001, "Team", "team", null]);
  });

  it("rejects a non-manager before calling Telegram", async () => {
    const { ProjectAccessError } = await import("@/lib/project-permissions");
    mocks.requireSelectedProjectPermission.mockRejectedValueOnce(new ProjectAccessError("permission_denied"));

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
