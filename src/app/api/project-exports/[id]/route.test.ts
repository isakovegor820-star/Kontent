import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  getPool: vi.fn(() => ({})),
  getSessionUser: vi.fn(),
  hasTrustedMutationOrigin: vi.fn(),
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(),
  getProjectExportOperation: vi.fn(),
  revokeProjectExportOperation: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: mocks.hasTrustedMutationOrigin }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: mocks.rateLimitResponse,
}));
vi.mock("@/lib/project-export-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/project-export-service")>("@/lib/project-export-service");
  return {
    ...actual,
    getProjectExportOperation: mocks.getProjectExportOperation,
    revokeProjectExportOperation: mocks.revokeProjectExportOperation,
  };
});

import { DELETE, GET } from "./route";

const context = { params: Promise.resolve({ id: "41" }) };

describe("project export operation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 9 });
    mocks.hasTrustedMutationOrigin.mockReturnValue(true);
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, limit: 60, remaining: 59, retryAfter: 0 });
    mocks.rateLimitResponse.mockImplementation(() => NextResponse.json({ error: "limited" }, { status: 429 }));
    mocks.getProjectExportOperation.mockResolvedValue({ id: 41, status: "ready" });
    mocks.revokeProjectExportOperation.mockResolvedValue({ id: 41, status: "expired" });
  });

  it("reads an operation through the project-scoped service", async () => {
    const response = await GET(new NextRequest("http://localhost/api/project-exports/41"), context);
    expect(response.status).toBe(200);
    expect(mocks.getProjectExportOperation).toHaveBeenCalledWith(expect.anything(), 9, "41");
  });

  it("rejects cross-origin revocation before session lookup", async () => {
    mocks.hasTrustedMutationOrigin.mockReturnValue(false);
    const response = await DELETE(
      new NextRequest("http://localhost/api/project-exports/41", { method: "DELETE" }),
      context,
    );
    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
  });
});
