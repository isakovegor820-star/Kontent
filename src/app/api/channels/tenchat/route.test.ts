import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  requireSelectedProjectPermission: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: () => ({ query: vi.fn() }) }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/project-permissions", () => ({
  ProjectAccessError: class ProjectAccessError extends Error {},
  requireSelectedProjectPermission: mocks.requireSelectedProjectPermission,
}));

import { GET } from "./route";

const keys = [
  "TENCHAT_OFFICIAL_ACCESS_MODE",
  "TENCHAT_OFFICIAL_ACCESS_GRANT_ID",
  "TENCHAT_OFFICIAL_API_BASE_URL",
  "TENCHAT_OFFICIAL_API_TOKEN",
] as const;

describe("GET /api/channels/tenchat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.requireSelectedProjectPermission.mockResolvedValue({ projectId: 31 });
  });

  afterEach(() => {
    for (const key of keys) delete process.env[key];
  });

  it("returns redacted export-only readiness even when server credentials are supplied", async () => {
    process.env.TENCHAT_OFFICIAL_ACCESS_MODE = "written_partner_agreement";
    process.env.TENCHAT_OFFICIAL_ACCESS_GRANT_ID = "official-grant-2026";
    process.env.TENCHAT_OFFICIAL_API_BASE_URL = "https://api.tenchat.ru/v1";
    process.env.TENCHAT_OFFICIAL_API_TOKEN = "S".repeat(48);
    const response = await GET(new NextRequest("http://localhost/api/channels/tenchat"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.provider).toMatchObject({
      mode: "export_only",
      livePublish: { available: false, terminal: true, retryable: false },
      exportPackage: { available: true },
      configuration: { configuredForImplementation: true, secretsExposed: false },
    });
    expect(JSON.stringify(body)).not.toContain(process.env.TENCHAT_OFFICIAL_API_TOKEN);
    expect(JSON.stringify(body)).not.toContain(process.env.TENCHAT_OFFICIAL_ACCESS_GRANT_ID);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("requires an authenticated project member", async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    const response = await GET(new NextRequest("http://localhost/api/channels/tenchat"));
    expect(response.status).toBe(401);
    expect(mocks.requireSelectedProjectPermission).not.toHaveBeenCalled();
  });
});
