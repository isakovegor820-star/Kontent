import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getOAuthConfig: vi.fn(),
  buildAuthUrl: vi.fn(),
  randomState: vi.fn(),
  randomPkce: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/social-providers.mjs", () => ({ getOAuthConfig: mocks.getOAuthConfig }));
vi.mock("@/lib/oauth.mjs", () => ({
  buildAuthUrl: mocks.buildAuthUrl,
  randomState: mocks.randomState,
  randomPkce: mocks.randomPkce,
}));

import { GET } from "./route";

describe("GET /api/channels/oauth/start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 5 });
    mocks.getOAuthConfig.mockReturnValue({
      id: "youtube",
      authEndpoint: "https://provider.example/authorize",
      tokenEndpoint: "https://provider.example/token",
      clientId: "configured",
      clientSecret: "secret",
      scopes: ["publish"],
    });
  });

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
});
