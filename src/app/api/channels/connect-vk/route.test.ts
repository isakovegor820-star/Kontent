import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  requireSelectedProjectPermission: vi.fn(),
  requireProjectPermission: vi.fn(),
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
    requireProjectPermission: mocks.requireProjectPermission,
  };
});
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
    mocks.requireProjectPermission.mockResolvedValue({ projectId: 12 });
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, limit: 10, remaining: 9, retryAfter: 0 });
    mocks.clientIp.mockReturnValue("127.0.0.1");
    mocks.resolveGroupByToken.mockResolvedValue({ groupId: 55, name: "VK Team", screenName: "vk-team" });
    mocks.encryptToken.mockReturnValue("encrypted-token");
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("select id from channels")) return { rows: [], rowCount: 0 };
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

  it("rejects a non-manager before validating or encrypting their token", async () => {
    const { ProjectAccessError } = await import("@/lib/project-permissions");
    mocks.requireSelectedProjectPermission.mockRejectedValueOnce(new ProjectAccessError("permission_denied"));

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(mocks.resolveGroupByToken).not.toHaveBeenCalled();
    expect(mocks.encryptToken).not.toHaveBeenCalled();
  });
});
