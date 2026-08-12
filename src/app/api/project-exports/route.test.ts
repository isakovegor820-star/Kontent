import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  getPool: vi.fn(() => ({ query: vi.fn() })),
  getSessionUser: vi.fn(),
  hasTrustedMutationOrigin: vi.fn(),
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(),
  createProjectExportOperation: vi.fn(),
  getProjectExportOperation: vi.fn(),
  listProjectExportOperations: vi.fn(),
  processProjectExportOperation: vi.fn(),
  reconcileProjectExportOutbox: vi.fn(),
  enqueueProjectExportJob: vi.fn(),
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
  return {
    ...actual,
    createProjectExportOperation: mocks.createProjectExportOperation,
    getProjectExportOperation: mocks.getProjectExportOperation,
    listProjectExportOperations: mocks.listProjectExportOperations,
  };
});
vi.mock("@/lib/project-export-operation.mjs", async () => {
  const actual = await vi.importActual<typeof import("@/lib/project-export-operation.mjs")>("@/lib/project-export-operation.mjs");
  return { ...actual, processProjectExportOperation: mocks.processProjectExportOperation };
});
vi.mock("@/lib/project-export-outbox.mjs", () => ({
  reconcileProjectExportOutbox: mocks.reconcileProjectExportOutbox,
}));
vi.mock("@/lib/project-export-queue.mjs", () => ({
  enqueueProjectExportJob: mocks.enqueueProjectExportJob,
}));

import { GET, POST } from "./route";

function request(method: "GET" | "POST", body?: object) {
  return new NextRequest("http://localhost/api/project-exports", {
    method,
    headers: method === "POST"
      ? { origin: "http://localhost", "idempotency-key": "export-route-001", "content-type": "application/json" }
      : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function rawPost(body: string, contentType = "application/json") {
  return new NextRequest("http://localhost/api/project-exports", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      "idempotency-key": "export-route-001",
      "content-type": contentType,
    },
    body,
  });
}

describe("project export collection route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasTrustedMutationOrigin.mockReturnValue(true);
    mocks.getSessionUser.mockResolvedValue({ id: 9 });
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, limit: 30, remaining: 29, retryAfter: 0 });
    mocks.rateLimitResponse.mockImplementation(() => NextResponse.json({ error: "limited" }, { status: 429 }));
    mocks.getProjectExportOperation.mockResolvedValue({ id: 41, status: "ready" });
    mocks.processProjectExportOperation.mockResolvedValue({ outcome: "ready" });
  });

  it("rejects a cross-origin mutation before reading the session", async () => {
    mocks.hasTrustedMutationOrigin.mockReturnValue(false);
    const response = await POST(request("POST", {}));
    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
  });

  it("rejects unsupported, oversized, and unknown request input before creating an operation", async () => {
    const unsupported = await POST(rawPost("{}", "text/plain"));
    expect(unsupported.status).toBe(415);
    expect(await unsupported.json()).toMatchObject({ error: "unsupported_media_type" });

    const oversized = await POST(rawPost(JSON.stringify({ padding: "x".repeat(33 * 1024) })));
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: "body_too_large" });

    const unknown = await POST(request("POST", {
      kind: "content_plan",
      format: "csv",
      period: { from: "2026-08-01", to: "2026-08-31" },
      previewHash: "c".repeat(64),
      projectId: 999,
    }));
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: "invalid_export_request" });
    expect(mocks.createProjectExportOperation).not.toHaveBeenCalled();
  });

  it("renders a small immutable export before returning it", async () => {
    mocks.createProjectExportOperation.mockResolvedValue({
      id: 41,
      projectId: 7,
      snapshotHash: "a".repeat(64),
      status: "pending",
      dispatch: "sync",
      replayed: false,
    });
    const response = await POST(request("POST", {
      kind: "content_plan",
      format: "csv",
      period: { from: "2026-08-01", to: "2026-08-31" },
      previewHash: "c".repeat(64),
    }));
    expect(response.status).toBe(201);
    expect(mocks.processProjectExportOperation).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 41,
      projectId: 7,
      snapshotHash: "a".repeat(64),
    }));
    expect(await response.json()).toEqual(expect.objectContaining({
      ok: true,
      operation: { id: 41, status: "ready" },
      replayed: false,
    }));
  });

  it("dispatches a large export through the durable outbox", async () => {
    mocks.createProjectExportOperation.mockResolvedValue({
      id: 42,
      projectId: 7,
      snapshotHash: "b".repeat(64),
      status: "pending",
      dispatch: "queue",
      replayed: false,
    });
    mocks.getProjectExportOperation.mockResolvedValue({ id: 42, status: "queued" });
    const response = await POST(request("POST", {
      kind: "analytics",
      format: "xlsx",
      period: { from: "2026-01-01", to: "2026-08-31" },
      previewHash: "d".repeat(64),
    }));
    expect(response.status).toBe(202);
    expect(mocks.reconcileProjectExportOutbox).toHaveBeenCalledWith(expect.objectContaining({ operationId: 42 }));
    expect(mocks.processProjectExportOperation).not.toHaveBeenCalled();
  });

  it("returns an in-progress HTTP replay without claiming the renderer again", async () => {
    mocks.createProjectExportOperation.mockResolvedValue({
      id: 43,
      projectId: 7,
      snapshotHash: "e".repeat(64),
      status: "rendering",
      dispatch: "sync",
      replayed: true,
    });
    mocks.getProjectExportOperation.mockResolvedValue({ id: 43, status: "rendering" });
    const response = await POST(request("POST", {
      kind: "content_plan",
      format: "pdf",
      period: { from: "2026-08-01", to: "2026-08-31" },
      previewHash: "f".repeat(64),
    }));
    expect(response.status).toBe(202);
    expect(mocks.processProjectExportOperation).not.toHaveBeenCalled();
    expect(mocks.reconcileProjectExportOutbox).not.toHaveBeenCalled();
  });

  it("lists only service-authorized operations", async () => {
    mocks.listProjectExportOperations.mockResolvedValue([{ id: 1, status: "ready" }]);
    const response = await GET(request("GET"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, exports: [{ id: 1, status: "ready" }] });
    expect(mocks.listProjectExportOperations).toHaveBeenCalledWith(expect.anything(), 9, null);
  });
});
