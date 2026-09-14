import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  getPool: vi.fn(() => ({})),
  getSessionUser: vi.fn(),
  hasTrustedMutationOrigin: vi.fn(),
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(),
  createProjectExportDownloadToken: vi.fn(),
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
  return { ...actual, createProjectExportDownloadToken: mocks.createProjectExportDownloadToken };
});

import { POST } from "./route";

describe("project export download token route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasTrustedMutationOrigin.mockReturnValue(true);
    mocks.getSessionUser.mockResolvedValue({ id: 9 });
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, limit: 60, remaining: 59, retryAfter: 0 });
    mocks.rateLimitResponse.mockImplementation(() => NextResponse.json({ error: "limited" }, { status: 429 }));
    mocks.createProjectExportDownloadToken.mockResolvedValue({
      token: "A".repeat(43),
      expiresAt: "2026-08-11T12:15:00.000Z",
    });
  });

  it("rejects untrusted origins before session and token creation", async () => {
    mocks.hasTrustedMutationOrigin.mockReturnValue(false);
    const response = await POST(
      new NextRequest("http://localhost/api/project-exports/41/download-token", { method: "POST" }),
      { params: Promise.resolve({ id: "41" }) },
    );
    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
  });

  it("returns the token separately from a token-free download URL", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/project-exports/41/download-token", { method: "POST" }),
      { params: Promise.resolve({ id: "41" }) },
    );
    const body = await response.json();
    expect(body.token).toBe("A".repeat(43));
    expect(body.downloadUrl).toBe("/api/project-exports/41/download");
    expect(body.downloadUrl).not.toContain(body.token);
    expect(body.tokenHeader).toBe("x-export-download-token");
  });
});
