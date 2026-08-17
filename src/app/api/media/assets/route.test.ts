import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  requireSelectedProjectPermission: vi.fn(),
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(),
  readRequestBodyLimited: vi.fn(),
  inspectUploadedImage: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/project-permissions", async () => {
  const actual = await vi.importActual<typeof import("@/lib/project-permissions")>("@/lib/project-permissions");
  return { ...actual, requireSelectedProjectPermission: mocks.requireSelectedProjectPermission };
});
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: mocks.rateLimitResponse,
}));
vi.mock("@/lib/bounded-request-body", async () => {
  const actual = await vi.importActual<typeof import("@/lib/bounded-request-body")>("@/lib/bounded-request-body");
  return { ...actual, readRequestBodyLimited: mocks.readRequestBodyLimited };
});
vi.mock("@/lib/uploaded-image", () => ({ inspectUploadedImage: mocks.inspectUploadedImage }));

import { ProjectAccessError } from "@/lib/project-permissions";
import {
  acquireMediaAssetBodySlot,
  MAX_CONCURRENT_MEDIA_ASSET_BODIES,
} from "@/lib/bounded-request-body";
import { POST } from "./route";

afterEach(() => vi.restoreAllMocks());

function multipartRequest(headers: HeadersInit = {}) {
  return new NextRequest("http://localhost/api/media/assets", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      "content-type": "multipart/form-data; boundary=aurora-test",
      ...headers,
    },
    body: "--aurora-test--\r\n",
  });
}

describe("POST /api/media/assets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.requireSelectedProjectPermission.mockResolvedValue({ projectId: 41, userId: 7, role: "author" });
    mocks.checkRateLimit.mockResolvedValue({
      allowed: true,
      limit: 30,
      remaining: 29,
      retryAfter: 0,
    });
    mocks.rateLimitResponse.mockImplementation(() => NextResponse.json({ error: "rate_limited" }, { status: 429 }));
  });

  it("rejects a publisher before reading or decoding the multipart body", async () => {
    mocks.requireSelectedProjectPermission.mockRejectedValueOnce(
      new ProjectAccessError("permission_denied"),
    );

    const response = await POST(multipartRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "access_denied" });
    expect(mocks.requireSelectedProjectPermission).toHaveBeenCalledWith(
      expect.objectContaining({ query: mocks.query }),
      7,
      "content.create",
    );
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.readRequestBodyLimited).not.toHaveBeenCalled();
    expect(mocks.inspectUploadedImage).not.toHaveBeenCalled();
  });

  it("rejects an oversized multipart envelope before buffering it", async () => {
    const response = await POST(multipartRequest({ "content-length": String(11 * 1024 * 1024) }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "payload_too_large" });
    expect(mocks.checkRateLimit).toHaveBeenCalledTimes(2);
    expect(mocks.readRequestBodyLimited).not.toHaveBeenCalled();
    expect(mocks.inspectUploadedImage).not.toHaveBeenCalled();
  });

  it("rejects excess concurrent image decodes before buffering the body", async () => {
    const operationalLog = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const releases = Array.from(
      { length: MAX_CONCURRENT_MEDIA_ASSET_BODIES },
      () => acquireMediaAssetBodySlot(),
    );
    try {
      const response = await POST(multipartRequest());

      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("2");
      await expect(response.json()).resolves.toMatchObject({ error: "upload_busy" });
      expect(operationalLog).toHaveBeenCalledWith(
        expect.stringContaining('"event":"upload_busy"'),
      );
      expect(mocks.readRequestBodyLimited).not.toHaveBeenCalled();
      expect(mocks.inspectUploadedImage).not.toHaveBeenCalled();
    } finally {
      for (const release of releases) release();
    }
  });
});
