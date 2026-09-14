import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  hasTrustedMutationOrigin: vi.fn(),
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(),
  recordGrowthTelemetry: vi.fn(),
  isGrowthAccessError: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: mocks.hasTrustedMutationOrigin }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit, rateLimitResponse: mocks.rateLimitResponse }));
vi.mock("@/lib/growth", () => ({
  GROWTH_TELEMETRY_EVENTS: ["growth.board.viewed", "growth.evidence.opened", "growth.move.started"],
  recordGrowthTelemetry: mocks.recordGrowthTelemetry,
  isGrowthAccessError: mocks.isGrowthAccessError,
}));

import { POST } from "./route";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/growth/events", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

describe("Growth telemetry API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasTrustedMutationOrigin.mockReturnValue(true);
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.checkRateLimit.mockResolvedValue({ allowed: true });
    mocks.recordGrowthTelemetry.mockResolvedValue(undefined);
  });

  it("accepts only bounded ids and an allow-listed event without user content", async () => {
    const response = await POST(request({ event: "growth.move.started", moveId: 12, channelId: 4 }));
    expect(response.status).toBe(200);
    expect(mocks.recordGrowthTelemetry).toHaveBeenCalledWith({
      actorUserId: 7, event: "growth.move.started", moveId: 12, channelId: 4,
    });
  });

  it("rejects arbitrary telemetry names", async () => {
    const response = await POST(request({ event: "post.text", text: "private" }));
    expect(response.status).toBe(400);
    expect(mocks.recordGrowthTelemetry).not.toHaveBeenCalled();
  });
});
