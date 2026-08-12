import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getDesign: vi.fn(),
  updateDesign: vi.fn(),
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
  getLegalVisualDesign: mocks.getDesign,
  updateLegalVisualDesign: mocks.updateDesign,
}));

import { LegalVisualServiceError } from "@/lib/legal-visual-service";
import { GET, PATCH } from "./route";

const context = { params: Promise.resolve({ id: "101" }) };

describe("legal visual item route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 12 });
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, limit: 120, remaining: 119, retryAfter: 0 });
  });

  it("uses the authenticated actor for the project-scoped design read", async () => {
    mocks.getDesign.mockResolvedValue({ id: 101, projectId: 7 });
    const response = await GET(new NextRequest("http://localhost/api/legal-visuals/101"), context);
    expect(response.status).toBe(200);
    expect(mocks.getDesign).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 12,
      designId: 101,
    }));
  });

  it("returns 409 for a stale expected revision and does not hide it as a server error", async () => {
    mocks.updateDesign.mockRejectedValue(new LegalVisualServiceError("version_conflict"));
    const response = await PATCH(new NextRequest("http://localhost/api/legal-visuals/101", {
      method: "PATCH",
      headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 3, config: {} }),
    }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "version_conflict" });
    expect(mocks.updateDesign).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 12,
      designId: 101,
      expectedRevision: 3,
    }));
  });
});
