import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  createTenChatExportForProject: vi.fn(),
  getSessionUser: vi.fn(),
  hasTrustedMutationOrigin: vi.fn(),
  requireSelectedProjectPermission: vi.fn(),
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: () => ({ query: vi.fn() }) }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: mocks.hasTrustedMutationOrigin }));
vi.mock("@/lib/project-permissions", () => ({
  ProjectAccessError: class ProjectAccessError extends Error {},
  requireSelectedProjectPermission: mocks.requireSelectedProjectPermission,
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  clientIp: vi.fn(() => "127.0.0.1"),
  rateLimitResponse: mocks.rateLimitResponse,
}));
vi.mock("@/lib/tenchat-export-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tenchat-export-service")>(
    "@/lib/tenchat-export-service",
  );
  return { ...actual, createTenChatExportForProject: mocks.createTenChatExportForProject };
});

import { POST } from "./route";

function request(body: object = { text: "Пост", assetIds: [], draftId: 81, draftVersion: 3 }) {
  return new NextRequest("http://localhost/api/channels/tenchat/export", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rawRequest(body: BodyInit, contentType = "application/json", headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/channels/tenchat/export", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": contentType, ...headers },
    body,
  });
}

describe("POST /api/channels/tenchat/export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasTrustedMutationOrigin.mockReturnValue(true);
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.requireSelectedProjectPermission.mockResolvedValue({ projectId: 31 });
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 10 });
    mocks.rateLimitResponse.mockImplementation(() => NextResponse.json({ error: "rate_limited" }, { status: 429 }));
    mocks.createTenChatExportForProject.mockResolvedValue({
      bytes: Buffer.from("zip-bytes"),
      filename: "Проект-tenchat-package.zip",
      contentType: "application/zip",
      sha256: "a".repeat(64),
    });
  });

  it("returns a download that explicitly denies live publication", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/zip");
    expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    expect(response.headers.get("x-aurora-live-published")).toBe("false");
    expect(response.headers.get("x-aurora-provider-mode")).toBe("export_only");
    expect(mocks.createTenChatExportForProject).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 31,
      actorUserId: 7,
      body: { text: "Пост", assetIds: [], draftId: 81, draftVersion: 3 },
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    }));
    expect(response.headers.get("x-request-id")).toBe(
      mocks.createTenChatExportForProject.mock.calls[0]?.[0]?.requestId,
    );
  });

  it("requires a trusted origin before session or package work", async () => {
    mocks.hasTrustedMutationOrigin.mockReturnValue(false);
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.createTenChatExportForProject).not.toHaveBeenCalled();
  });

  it("requires publication permission because manual export can bypass live workflow", async () => {
    await POST(request());
    expect(mocks.requireSelectedProjectPermission).toHaveBeenCalledWith(
      expect.anything(),
      7,
      "content.publish",
    );
  });

  it("rejects unsupported media, unknown keys, oversized streams and malformed UTF-8", async () => {
    expect((await POST(rawRequest("{}", "text/plain"))).status).toBe(415);
    expect((await POST(request({
      text: "Пост", assetIds: [], draftId: 81, draftVersion: 3, projectId: 999,
    }))).status).toBe(400);
    expect((await POST(rawRequest(
      JSON.stringify({ text: "x".repeat(70_000), assetIds: [], draftId: 81, draftVersion: 3 }),
      "application/json",
      { "content-length": "2" },
    ))).status).toBe(413);
    expect((await POST(rawRequest(
      new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x28, 0x7d]) as BodyInit,
    ))).status).toBe(400);
    expect(mocks.createTenChatExportForProject).not.toHaveBeenCalled();
  });

  it("does not read the body when fail-closed rate limiting denies the request", async () => {
    mocks.checkRateLimit.mockResolvedValue({ allowed: false, unavailable: true, retryAfter: 30 });
    mocks.rateLimitResponse.mockReturnValue(NextResponse.json({ error: "rate_limit_unavailable" }, { status: 503 }));
    const stream = new ReadableStream<Uint8Array>({
      pull() { throw new Error("body must not be read"); },
    });
    const response = await POST(new NextRequest("http://localhost/api/channels/tenchat/export", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as never));
    expect(response.status).toBe(503);
    expect(mocks.createTenChatExportForProject).not.toHaveBeenCalled();
  });
});
