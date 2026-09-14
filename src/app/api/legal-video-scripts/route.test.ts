import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  listScripts: vi.fn(),
  createScript: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: vi.fn() }) }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/rate-limit")>(),
  checkRateLimit: mocks.checkRateLimit,
}));
vi.mock("@/lib/legal-video-script-service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/legal-video-script-service")>(),
  listLegalVideoScripts: mocks.listScripts,
  createLegalVideoScriptRecord: mocks.createScript,
}));

import { ProjectAccessError } from "@/lib/project-permissions";
import { LegalVideoScriptServiceError } from "@/lib/legal-video-script-service";
import { GET, POST } from "./route";

function request(method: "GET" | "POST", body?: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/legal-video-scripts", {
    method,
    headers: {
      origin: "http://localhost",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("legal video collection route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 12 });
    mocks.listScripts.mockResolvedValue([]);
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, limit: 60, remaining: 59, retryAfter: 0 });
  });

  it("rejects unsupported media and unknown create fields before service work", async () => {
    const unsupported = await POST(new NextRequest("http://localhost/api/legal-video-scripts", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "text/plain" },
      body: "{}",
    }));
    expect(unsupported.status).toBe(415);
    expect((await POST(request("POST", { draftId: 51, requestKey: "video-create-001", projectId: 99 }))).status).toBe(400);
    expect(mocks.createScript).not.toHaveBeenCalled();
  });

  it("requires a session before listing project scripts", async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    const response = await GET(request("GET"));
    expect(response.status).toBe(401);
    expect(mocks.listScripts).not.toHaveBeenCalled();
  });

  it("passes session actor and exact create intent, returning 201 then 200 replay", async () => {
    const body = {
      draftId: 51,
      requestKey: "video-create-001",
      durationSeconds: 45,
      title: "Срок ответа",
    };
    mocks.createScript.mockResolvedValueOnce({ script: { id: 201 }, duplicate: false });
    const created = await POST(request("POST", body));
    expect(created.status).toBe(201);
    expect(mocks.createScript).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 12,
      draftId: 51,
      requestKey: "video-create-001",
      durationSeconds: 45,
    }));

    mocks.createScript.mockResolvedValueOnce({ script: { id: 201 }, duplicate: true });
    expect((await POST(request("POST", body))).status).toBe(200);
  });

  it("maps project isolation denial to 403", async () => {
    mocks.listScripts.mockRejectedValue(new ProjectAccessError("permission_denied"));
    const response = await GET(request("GET"));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "access_denied" });
  });

  it("returns 409 for an idempotency key reused with another video intent", async () => {
    mocks.createScript.mockRejectedValue(new LegalVideoScriptServiceError("idempotency_conflict"));
    const response = await POST(request("POST", {
      draftId: 52,
      requestKey: "video-create-001",
      durationSeconds: 60,
    }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "idempotency_conflict" });
  });
});
