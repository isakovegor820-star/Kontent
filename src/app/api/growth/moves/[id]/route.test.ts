import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(), hasTrustedMutationOrigin: vi.fn(), checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(), updateGrowthMoveStatus: vi.fn(), getGrowthMove: vi.fn(),
  isGrowthAccessError: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: mocks.hasTrustedMutationOrigin }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit, rateLimitResponse: mocks.rateLimitResponse }));
vi.mock("@/lib/growth", () => ({
  updateGrowthMoveStatus: mocks.updateGrowthMoveStatus,
  getGrowthMove: mocks.getGrowthMove,
  isGrowthAccessError: mocks.isGrowthAccessError,
}));

import { POST } from "./route";

describe("Growth move API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.hasTrustedMutationOrigin.mockReturnValue(true);
    mocks.checkRateLimit.mockResolvedValue({ allowed: true });
    mocks.updateGrowthMoveStatus.mockResolvedValue({ id: 12, status: "skipped" });
  });

  it("keeps skip as the neutral lifecycle escape", async () => {
    const req = new NextRequest("http://localhost/api/growth/moves/12", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ action: "skip" }),
    });
    const response = await POST(req, { params: Promise.resolve({ id: "12" }) });
    expect(response.status).toBe(200);
    expect(mocks.updateGrowthMoveStatus).toHaveBeenCalledWith({ actorUserId: 7, moveId: 12, status: "skipped" });
  });

  it("rejects unknown manual lifecycle mutations", async () => {
    const req = new NextRequest("http://localhost/api/growth/moves/12", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ action: "published" }),
    });
    const response = await POST(req, { params: Promise.resolve({ id: "12" }) });
    expect(response.status).toBe(400);
    expect(mocks.updateGrowthMoveStatus).not.toHaveBeenCalled();
  });
});
