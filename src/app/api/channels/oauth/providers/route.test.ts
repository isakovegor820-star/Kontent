import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getOAuthConfig: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/social-providers.mjs", () => ({ getOAuthConfig: mocks.getOAuthConfig }));

import { GET } from "./route";

describe("GET /api/channels/oauth/providers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 5 });
    mocks.getOAuthConfig.mockImplementation((network: string) =>
      network === "youtube" ? { clientId: "configured" } : null,
    );
  });

  it("keeps configured providers unavailable until Composer supports their payload", async () => {
    const response = await GET(new NextRequest("http://localhost/api/channels/oauth/providers"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      providers: {
        youtube: {
          available: false,
          status: "unsupported",
          reason: "composer_unsupported",
          message: "Подключение YouTube станет доступно, когда публикация в YouTube появится в Композиторе.",
        },
        instagram: {
          available: false,
          status: "unsupported",
          reason: "composer_unsupported",
          message: "Подключение Instagram станет доступно, когда публикация в Instagram появится в Композиторе.",
        },
      },
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("requires an authenticated account", async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    const response = await GET(new NextRequest("http://localhost/api/channels/oauth/providers"));
    expect(response.status).toBe(401);
    expect(mocks.getOAuthConfig).not.toHaveBeenCalled();
  });
});
