import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  getPool: vi.fn(() => ({ query: vi.fn() })),
  getSessionUser: vi.fn(),
  hasTrustedMutationOrigin: vi.fn(),
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(),
  previewProjectExport: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: mocks.hasTrustedMutationOrigin }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  clientIp: vi.fn(() => "127.0.0.1"),
  rateLimitResponse: mocks.rateLimitResponse,
}));
vi.mock("@/lib/project-export-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/project-export-service")>("@/lib/project-export-service");
  return { ...actual, previewProjectExport: mocks.previewProjectExport };
});

import { POST } from "./route";

function request(body: object) {
  return new NextRequest("http://localhost/api/project-exports/preview", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rawRequest(body: string, contentType = "application/json") {
  return new NextRequest("http://localhost/api/project-exports/preview", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": contentType },
    body,
  });
}

describe("project export preview route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasTrustedMutationOrigin.mockReturnValue(true);
    mocks.getSessionUser.mockResolvedValue({ id: 9 });
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, limit: 120, remaining: 119, retryAfter: 0 });
    mocks.rateLimitResponse.mockImplementation(() => NextResponse.json({ error: "limited" }, { status: 429 }));
  });

  it("returns only the authenticated selected-project preview", async () => {
    const preview = {
      kind: "content_plan",
      timezone: "Europe/Amsterdam",
      period: { from: "2026-08-01", to: "2026-08-31" },
      filters: { channel: [], author: [], campaign: [], status: [] },
      rowCount: 3,
      exceedsLimit: false,
      previewHash: "a".repeat(64),
      sample: [],
    };
    mocks.previewProjectExport.mockResolvedValue(preview);
    const body = {
      kind: "content_plan",
      format: "xlsx",
      period: { from: "2026-08-01", to: "2026-08-31" },
    };
    const response = await POST(request(body));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, preview });
    expect(mocks.previewProjectExport).toHaveBeenCalledWith({
      db: expect.anything(),
      actorUserId: 9,
      body,
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("rejects an untrusted origin before reading the session or data", async () => {
    mocks.hasTrustedMutationOrigin.mockReturnValue(false);
    const response = await POST(request({}));
    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.previewProjectExport).not.toHaveBeenCalled();
  });

  it("rejects unsupported, oversized, and unknown input before querying project data", async () => {
    const unsupported = await POST(rawRequest("{}", "text/plain"));
    expect(unsupported.status).toBe(415);
    expect(await unsupported.json()).toMatchObject({ error: "unsupported_media_type" });

    const oversized = await POST(rawRequest(JSON.stringify({ padding: "x".repeat(33 * 1024) })));
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: "body_too_large" });

    const unknown = await POST(request({
      kind: "content_plan",
      format: "csv",
      period: { from: "2026-08-01", to: "2026-08-31" },
      projectId: 999,
    }));
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: "invalid_export_request" });
    expect(mocks.previewProjectExport).not.toHaveBeenCalled();
  });
});
