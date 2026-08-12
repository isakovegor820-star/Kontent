import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  listDesigns: vi.fn(),
  createDesign: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: vi.fn() }) }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/rate-limit")>(),
  checkRateLimit: mocks.checkRateLimit,
}));
vi.mock("@/lib/legal-visual-service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/legal-visual-service")>(),
  listLegalVisualDesigns: mocks.listDesigns,
  createLegalVisualDesign: mocks.createDesign,
}));

import { ProjectAccessError } from "@/lib/project-permissions";
import { LegalVisualServiceError } from "@/lib/legal-visual-service";
import { GET, POST } from "./route";

function request(method: "GET" | "POST", body?: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/legal-visuals", {
    method,
    headers: {
      origin: "http://localhost",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("legal visual collection route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 12 });
    mocks.listDesigns.mockResolvedValue([]);
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, limit: 60, remaining: 59, retryAfter: 0 });
  });

  it("rejects unknown keys and a lying Content-Length oversized stream before create", async () => {
    expect((await POST(request("POST", { requestKey: "visual-create-001", surprise: true }))).status).toBe(400);
    const oversized = await POST(new NextRequest("http://localhost/api/legal-visuals", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json", "content-length": "2" },
      body: JSON.stringify({ requestKey: "visual-create-001", config: { text: "x".repeat(140_000) } }),
    }));
    expect(oversized.status).toBe(413);
    expect(mocks.createDesign).not.toHaveBeenCalled();
  });

  it("requires a session before a project-scoped read", async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    const response = await GET(request("GET"));
    expect(response.status).toBe(401);
    expect(mocks.listDesigns).not.toHaveBeenCalled();
  });

  it("passes only the session actor into create and distinguishes create from replay", async () => {
    const body = {
      requestKey: "visual-create-001",
      sourceDraftId: 51,
      name: "Памятка",
      format: "4:5",
      template: "deadlines",
    };
    mocks.createDesign.mockResolvedValueOnce({ design: { id: 101 }, duplicate: false });
    const created = await POST(request("POST", body));
    expect(created.status).toBe(201);
    expect(mocks.createDesign).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 12,
      requestKey: "visual-create-001",
      sourceDraftId: 51,
    }));

    mocks.createDesign.mockResolvedValueOnce({ design: { id: 101 }, duplicate: true });
    const replay = await POST(request("POST", body));
    expect(replay.status).toBe(200);
  });

  it("maps selected-project RBAC denial without leaking another project", async () => {
    mocks.listDesigns.mockRejectedValue(new ProjectAccessError("permission_denied"));
    const response = await GET(request("GET"));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "access_denied" });
  });

  it("returns 409 when a reused idempotency key carries a different create intent", async () => {
    mocks.createDesign.mockRejectedValue(new LegalVisualServiceError("idempotency_conflict"));
    const response = await POST(request("POST", {
      requestKey: "visual-create-001",
      sourceDraftId: 52,
      name: "Другой материал",
    }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "idempotency_conflict" });
  });
});
