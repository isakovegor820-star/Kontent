import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  requireSelectedProjectPermission: vi.fn(),
  withSelectedProjectPermission: vi.fn(),
  resolveGroupByToken: vi.fn(),
  encryptToken: vi.fn(),
  checkRateLimit: vi.fn(),
  clientIp: vi.fn(),
  rateLimitResponse: vi.fn(),
  query: vi.fn(),
  transitionChannelHealth: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/project-permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-permissions")>();
  return {
    ...actual,
    requireSelectedProjectPermission: mocks.requireSelectedProjectPermission,
  };
});
vi.mock("@/lib/selected-project-transaction", () => ({ withSelectedProjectPermission: mocks.withSelectedProjectPermission }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/vk", () => ({ resolveGroupByToken: mocks.resolveGroupByToken }));
vi.mock("@/lib/token-crypto.mjs", () => ({ encryptToken: mocks.encryptToken }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  clientIp: mocks.clientIp,
  rateLimitResponse: mocks.rateLimitResponse,
}));
vi.mock("@/lib/channel-health.mjs", () => ({
  transitionChannelHealth: mocks.transitionChannelHealth,
}));

import { POST } from "./route";

const previousMasterKey = process.env.TOKENS_MASTER_KEY;

function request() {
  return new NextRequest("http://localhost/api/channels/connect-vk", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({ token: "vk-secret" }),
  });
}

describe("POST /api/channels/connect-vk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TOKENS_MASTER_KEY = "configured-for-test";
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.requireSelectedProjectPermission.mockResolvedValue({ projectId: 12 });
    mocks.withSelectedProjectPermission.mockImplementation(async (_pool, _userId, _permission, action) => action({ query: mocks.query }, { projectId: 12 }));
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, limit: 10, remaining: 9, retryAfter: 0 });
    mocks.clientIp.mockReturnValue("127.0.0.1");
    mocks.resolveGroupByToken.mockResolvedValue({ groupId: 55, name: "VK Team", screenName: "vk-team" });
    mocks.encryptToken.mockReturnValue("encrypted-token");
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("select id, user_id from channels")) return { rows: [], rowCount: 0 };
      if (sql.includes("insert into channels")) return { rows: [{ id: 41 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
  });

  afterEach(() => {
    if (previousMasterKey === undefined) delete process.env.TOKENS_MASTER_KEY;
    else process.env.TOKENS_MASTER_KEY = previousMasterKey;
  });

  it("stores the channel in the authorized project", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    const insert = mocks.query.mock.calls.find(([sql]) => String(sql).includes("insert into channels"));
    expect(String(insert?.[0])).toContain("project_id");
    expect(insert?.[1]).toEqual([12, 7, 55, "encrypted-token", "VK Team", "vk-team"]);
  });

  it("encrypts a reconnect with the persisted channel owner while keeping the current actor for its event", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("select id, user_id from channels")) {
        expect(sql).toContain("for update");
        return { rows: [{ id: 41, user_id: 19 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    expect((await POST(request())).status).toBe(200);
    expect(mocks.encryptToken).toHaveBeenCalledWith("vk-secret", { userId: 19, provider: "vk" });
    expect(mocks.transitionChannelHealth).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ channelId: 41, actorUserId: 7 }), { client: expect.anything() });
    const update = mocks.query.mock.calls.find(([sql]) => String(sql).includes("update channels"));
    expect(String(update?.[0])).not.toMatch(/set\s+user_id/iu);
  });

  it("does not retarget a connection when the server preference changes during validation", async () => {
    mocks.withSelectedProjectPermission.mockImplementationOnce(async (_pool, _userId, _permission, action) => action({ query: mocks.query }, { projectId: 13 }));
    expect((await POST(request())).status).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.transitionChannelHealth).not.toHaveBeenCalled();
  });

  it("rejects a non-manager before validating or encrypting their token", async () => {
    const { ProjectAccessError } = await import("@/lib/project-permissions");
    mocks.requireSelectedProjectPermission.mockRejectedValueOnce(new ProjectAccessError("permission_denied"));

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(mocks.resolveGroupByToken).not.toHaveBeenCalled();
    expect(mocks.encryptToken).not.toHaveBeenCalled();
  });
});
