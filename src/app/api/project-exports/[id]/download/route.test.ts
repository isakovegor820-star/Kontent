import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  getPool: vi.fn(() => ({})),
  getSessionUser: vi.fn(),
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(),
  resolveProjectExportDownload: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: mocks.rateLimitResponse,
}));
vi.mock("@/lib/project-export-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/project-export-service")>("@/lib/project-export-service");
  return { ...actual, resolveProjectExportDownload: mocks.resolveProjectExportDownload };
});

import { GET } from "./route";

describe("project export download route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 9 });
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, limit: 120, remaining: 119, retryAfter: 0 });
    mocks.rateLimitResponse.mockImplementation(() => NextResponse.json({ error: "limited" }, { status: 429 }));
    mocks.resolveProjectExportDownload.mockResolvedValue({
      bytes: Buffer.from("данные", "utf8"),
      fileName: "Проект-analytics-2026-08-01-2026-08-31.csv",
      mimeType: "text/csv; charset=utf-8",
    });
  });

  it("passes only the authenticated actor and header token to project authorization", async () => {
    const req = new NextRequest("http://localhost/api/project-exports/41/download", {
      headers: { "x-export-download-token": "A".repeat(43) },
    });
    const response = await GET(req, { params: Promise.resolve({ id: "41" }) });
    expect(response.status).toBe(200);
    expect(mocks.resolveProjectExportDownload).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 9,
      operationId: "41",
      token: "A".repeat(43),
    }));
    expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("requires a session before looking at the download token", async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    const response = await GET(
      new NextRequest("http://localhost/api/project-exports/41/download"),
      { params: Promise.resolve({ id: "41" }) },
    );
    expect(response.status).toBe(401);
    expect(mocks.resolveProjectExportDownload).not.toHaveBeenCalled();
  });
});
