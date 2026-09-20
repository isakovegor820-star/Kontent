import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  checkRateLimit: vi.fn(),
  clientIp: vi.fn(),
  rateLimitResponse: vi.fn(),
  getOAuthConfig: vi.fn(),
  getAdapter: vi.fn(),
  exchangeCode: vi.fn(),
  encryptToken: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
  requireProjectPermission: vi.fn(),
  hasComposerPayloadSupport: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  clientIp: mocks.clientIp,
  rateLimitResponse: mocks.rateLimitResponse,
}));
vi.mock("@/lib/db", () => ({ getPool: () => ({ connect: mocks.connect }) }));
vi.mock("@/lib/social-providers.mjs", () => ({
  getOAuthConfig: mocks.getOAuthConfig,
  getAdapter: mocks.getAdapter,
}));
vi.mock("@/lib/oauth.mjs", () => ({ exchangeCode: mocks.exchangeCode }));
vi.mock("@/lib/oauth-capabilities", () => ({ hasComposerPayloadSupport: mocks.hasComposerPayloadSupport }));
vi.mock("@/lib/project-permissions", async (original) => ({ ...await original<typeof import("@/lib/project-permissions")>(), requireProjectPermission: mocks.requireProjectPermission }));

import { GET } from "./route";
import { sealOAuthState } from "@/lib/oauth-state";

const previousMasterKey = process.env.TOKENS_MASTER_KEY;

function callbackRequest(overrides: { state?: string; network?: string; userId?: number; projectId?: number } = {}) {
  const state = overrides.state ?? "state-1";
  const network = overrides.network ?? "youtube";
  const saved = encodeURIComponent(sealOAuthState({
    state,
    verifier: "verifier-1",
    network,
    userId: overrides.userId ?? 7,
    projectId: overrides.projectId ?? 23,
  }));
  return new NextRequest(
    `http://localhost/api/channels/oauth/callback?network=${network}&code=code-1&state=${state}`,
    { headers: { cookie: `oauth_state=${saved}` } },
  );
}

describe("GET /api/channels/oauth/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TOKENS_MASTER_KEY = "configured-for-test";
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.requireProjectPermission.mockResolvedValue({ projectId: 23, role: "owner" });
    mocks.hasComposerPayloadSupport.mockReturnValue(true);
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, limit: 20, remaining: 19, retryAfter: 0 });
    mocks.clientIp.mockReturnValue("test-ip");
    mocks.getOAuthConfig.mockReturnValue({ id: "youtube" });
    mocks.getAdapter.mockReturnValue({
      finalizeTokens: vi.fn().mockResolvedValue({
        ok: true,
        externalId: "channel-external-1",
        meta: { title: "Channel", handle: "channel" },
      }),
    });
    mocks.exchangeCode.mockResolvedValue({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresIn: 3600,
      scope: "publish",
    });
    mocks.encryptToken.mockImplementation((value: string) => `encrypted:${value}`);
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("insert into oauth_tokens")) return { rows: [{ id: 91 }], rowCount: 1 };
      if (sql.includes("select id from channels")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });
  });

  afterEach(() => {
    if (previousMasterKey === undefined) delete process.env.TOKENS_MASTER_KEY;
    else process.env.TOKENS_MASTER_KEY = previousMasterKey;
  });

  it("commits token and channel atomically and burns the one-time state cookie", async () => {
    const response = await GET(callbackRequest());

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost/app/settings?connected=youtube&oauthProjectId=23");
    expect(response.headers.get("set-cookie")).toContain("oauth_state=");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    const statements = mocks.query.mock.calls.map(([sql]) => String(sql).trim());
    expect(statements[0]).toBe("begin");
    expect(statements.some((sql) => sql.includes("insert into oauth_tokens"))).toBe(true);
    expect(statements.some((sql) => sql.includes("insert into channels"))).toBe(true);
    expect(statements.at(-1)).toBe("commit");
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("rolls back the token when channel ownership conflicts", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("insert into oauth_tokens")) return { rows: [{ id: 91 }], rowCount: 1 };
      if (sql.includes("select id from channels")) return { rows: [], rowCount: 0 };
      if (sql.includes("insert into channels")) throw Object.assign(new Error("unique"), { code: "23505" });
      return { rows: [], rowCount: 1 };
    });

    const response = await GET(callbackRequest());

    expect(response.headers.get("location")).toBe(
      "http://localhost/app/settings?oauth=taken&network=youtube",
    );
    const statements = mocks.query.mock.calls.map(([sql]) => String(sql).trim());
    expect(statements.at(-1)).toBe("rollback");
    expect(statements).not.toContain("commit");
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("burns state before returning a validation error", async () => {
    const response = await GET(callbackRequest({ state: "different", userId: 99 }));

    expect(response.headers.get("location")).toContain("oauth=expired");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("refuses revoked project membership before exchanging a provider code", async () => {
    const { ProjectAccessError } = await import("@/lib/project-permissions");
    mocks.requireProjectPermission.mockRejectedValue(new ProjectAccessError("membership_required"));
    const response = await GET(callbackRequest());
    expect(response.headers.get("location")).toContain("oauth=forbidden");
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("writes the channel into the initiating project explicitly", async () => {
    await GET(callbackRequest());
    const insert = mocks.query.mock.calls.find(([sql]) => String(sql).includes("insert into channels"));
    expect(insert?.[0]).toMatch(/insert into channels \(project_id,/u);
    expect(insert?.[1]?.[0]).toBe(23);
  });
  it("rechecks revocation after exchange and rolls back before token/channel writes", async () => {
    const { ProjectAccessError } = await import("@/lib/project-permissions");
    mocks.requireProjectPermission.mockResolvedValueOnce({ projectId: 23, role: "owner" })
      .mockRejectedValueOnce(new ProjectAccessError("permission_denied"));
    const response = await GET(callbackRequest());
    expect(response.headers.get("location")).toContain("oauth=forbidden");
    expect(mocks.exchangeCode).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("insert into oauth_tokens"))).toBe(false);
    expect(mocks.query.mock.calls.at(-1)?.[0]).toBe("rollback");
  });
  it("does not reconnect another project's channel for the same account owner", async () => {
    await GET(callbackRequest({ projectId: 41 }));
    const read = mocks.query.mock.calls.find(([sql]) => String(sql).includes("select id from channels"));
    expect(read?.[0]).toContain("project_id = $3");
    expect(read?.[1]).toEqual([7, "channel-external-1", 41]);
    expect(mocks.requireProjectPermission).toHaveBeenNthCalledWith(1, expect.anything(), 7, 41, "project.manage");
  });
  it("retains the provider capability boundary if support disappears during consent", async () => {
    mocks.hasComposerPayloadSupport.mockReturnValue(false);
    expect((await GET(callbackRequest())).headers.get("location")).toContain("oauth=unsupported");
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
