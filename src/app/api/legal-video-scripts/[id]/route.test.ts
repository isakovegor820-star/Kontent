import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getScript: vi.fn(),
  updateScript: vi.fn(),
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
  getLegalVideoScript: mocks.getScript,
  updateLegalVideoScriptRecord: mocks.updateScript,
}));

import { LegalVideoScriptServiceError } from "@/lib/legal-video-script-service";
import { GET, PATCH } from "./route";

const context = { params: Promise.resolve({ id: "201" }) };

describe("legal video item route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 12 });
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, limit: 120, remaining: 119, retryAfter: 0 });
  });

  it("uses the authenticated actor for the project-scoped script read", async () => {
    mocks.getScript.mockResolvedValue({ id: 201, projectId: 7 });
    const response = await GET(new NextRequest("http://localhost/api/legal-video-scripts/201"), context);
    expect(response.status).toBe(200);
    expect(mocks.getScript).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 12,
      scriptId: 201,
    }));
  });

  it("surfaces stale revision as 409 and forwards the server-owned actor", async () => {
    mocks.updateScript.mockRejectedValue(new LegalVideoScriptServiceError("version_conflict"));
    const response = await PATCH(new NextRequest("http://localhost/api/legal-video-scripts/201", {
      method: "PATCH",
      headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 3, title: "Новый заголовок" }),
    }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "version_conflict" });
    expect(mocks.updateScript).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 12,
      scriptId: 201,
      expectedRevision: 3,
    }));
  });
});
