import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getOAuthConfig: vi.fn(),
  buildAuthUrl: vi.fn(),
  randomState: vi.fn(),
  randomPkce: vi.fn(),
  requireProjectPermission: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/lib/project-permissions", async (original) => ({ ...await original<typeof import("@/lib/project-permissions")>(), requireProjectPermission: mocks.requireProjectPermission }));
vi.mock("@/lib/social-providers.mjs", () => ({ getOAuthConfig: mocks.getOAuthConfig }));
vi.mock("@/lib/oauth.mjs", () => ({
  buildAuthUrl: mocks.buildAuthUrl,
  randomState: mocks.randomState,
  randomPkce: mocks.randomPkce,
}));

import { GET } from "./route";
import * as capabilities from "@/lib/oauth-capabilities";
import { openOAuthState } from "@/lib/oauth-state";

describe("GET /api/channels/oauth/start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 5 });
    mocks.requireProjectPermission.mockResolvedValue({ projectId: 23, role: "owner" });
    mocks.randomState.mockReturnValue("fixture-state");
    mocks.randomPkce.mockReturnValue({ verifier: "fixture-verifier", challenge: "fixture-challenge" });
    mocks.buildAuthUrl.mockReturnValue("https://provider.example/authorize");
    vi.stubEnv("TOKENS_MASTER_KEY", "isolated-oauth-fixture-key");
    mocks.getOAuthConfig.mockReturnValue({
      id: "youtube",
      authEndpoint: "https://provider.example/authorize",
      tokenEndpoint: "https://provider.example/token",
      clientId: "configured",
      clientSecret: "secret",
      scopes: ["publish"],
    });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it.each(["youtube", "instagram"])(
    "does not launch configured %s OAuth before Composer supports it",
    async (network) => {
      const response = await GET(
        new NextRequest(`http://localhost/api/channels/oauth/start?network=${network}`),
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        `http://localhost/app/settings?oauth=unsupported&network=${network}`,
      );
      expect(mocks.randomState).not.toHaveBeenCalled();
      expect(mocks.randomPkce).not.toHaveBeenCalled();
      expect(mocks.buildAuthUrl).not.toHaveBeenCalled();
      expect(response.headers.get("set-cookie")).toBeNull();
    },
  );

  it("keeps an unknown network on the not-configured path", async () => {
    mocks.getOAuthConfig.mockReturnValue(null);

    const response = await GET(
      new NextRequest("http://localhost/api/channels/oauth/start?network=unknown"),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost/app/settings?oauth=not_configured&network=unknown",
    );
    expect(mocks.buildAuthUrl).not.toHaveBeenCalled();
  });

  it("denies a newly configured OAuth adapter by default", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/channels/oauth/start?network=future-network"),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost/app/settings?oauth=unsupported&network=future-network",
    );
    expect(mocks.randomState).not.toHaveBeenCalled();
    expect(mocks.buildAuthUrl).not.toHaveBeenCalled();
  });

  it("requires an authenticated account before checking provider capability", async () => {
    mocks.getSessionUser.mockResolvedValue(null);

    const response = await GET(
      new NextRequest("http://localhost/api/channels/oauth/start?network=youtube"),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost/app/settings?oauth=unauthorized",
    );
    expect(mocks.getOAuthConfig).not.toHaveBeenCalled();
    expect(mocks.buildAuthUrl).not.toHaveBeenCalled();
  });
  it("binds a supported OAuth flow to the explicit native query project", async () => {
    vi.spyOn(capabilities, "getOAuthProviderCapability").mockReturnValue({ available: true, status: "available", reason: null, message: null });
    const response = await GET(new NextRequest("http://localhost/api/channels/oauth/start?network=youtube&projectId=23"));
    expect(mocks.requireProjectPermission).toHaveBeenCalledWith(expect.anything(), 5, 23, "project.manage");
    expect(openOAuthState(response.cookies.get("oauth_state")!.value, 5, "youtube")).toMatchObject({ projectId: 23, state: "fixture-state", verifier: "fixture-verifier" });
    expect(response.headers.get("location")).toBe("https://provider.example/authorize");
  });
  it.each(["", "&projectId=0", "&projectId=2&projectId=23"])("refuses absent or ambiguous native scope %s", async (query) => {
    vi.spyOn(capabilities, "getOAuthProviderCapability").mockReturnValue({ available: true, status: "available", reason: null, message: null });
    const response = await GET(new NextRequest(`http://localhost/api/channels/oauth/start?network=youtube${query}`));
    expect(response.headers.get("location")).toContain("oauth=forbidden");
    expect(mocks.buildAuthUrl).not.toHaveBeenCalled();
    expect(mocks.requireProjectPermission).not.toHaveBeenCalled();
  });
  it("denies a project member without project management permission before provider redirect", async () => {
    vi.spyOn(capabilities, "getOAuthProviderCapability").mockReturnValue({ available: true, status: "available", reason: null, message: null });
    const { ProjectAccessError } = await import("@/lib/project-permissions");
    mocks.requireProjectPermission.mockRejectedValue(new ProjectAccessError("permission_denied"));
    const response = await GET(new NextRequest("http://localhost/api/channels/oauth/start?network=youtube&projectId=23"));
    expect(response.headers.get("location")).toContain("oauth=forbidden");
    expect(mocks.buildAuthUrl).not.toHaveBeenCalled();
  });
});
