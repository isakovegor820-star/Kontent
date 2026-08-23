import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ProjectAccessError } from "@/lib/project-permissions";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  hasTrustedMutationOrigin: vi.fn(),
  setTodayRecommendationPreference: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: mocks.hasTrustedMutationOrigin }));
vi.mock("@/lib/today", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/today")>();
  return { ...original, setTodayRecommendationPreference: mocks.setTodayRecommendationPreference };
});

import { POST } from "./route";

function request(body: unknown = { channelId: 11, recommendationKind: "result_weak", state: "hidden" }) {
  return new NextRequest("http://localhost/api/today/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/today/feedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasTrustedMutationOrigin.mockReturnValue(true);
    mocks.getSessionUser.mockResolvedValue({ id: 9 });
    mocks.setTodayRecommendationPreference.mockResolvedValue(undefined);
  });

  it("requires trusted origin and authentication", async () => {
    mocks.hasTrustedMutationOrigin.mockReturnValueOnce(false);
    expect((await POST(request())).status).toBe(403);
    mocks.getSessionUser.mockResolvedValueOnce(null);
    expect((await POST(request())).status).toBe(401);
  });

  it("stores and restores only allowlisted recommendation kinds", async () => {
    expect((await POST(request())).status).toBe(200);
    expect(mocks.setTodayRecommendationPreference).toHaveBeenCalledWith({
      actorUserId: 9, channelId: 11, recommendationKind: "result_weak", state: "hidden",
    });
    expect((await POST(request({ channelId: 11, recommendationKind: "reviews", state: "hidden" }))).status).toBe(422);
    expect((await POST(request({ channelId: 11, recommendationKind: "result_weak", state: "active" }))).status).toBe(200);
    expect((await POST(request({ channelId: "other-project", recommendationKind: "result_weak", state: "hidden" }))).status).toBe(422);
  });

  it("does not convert access denial into an empty success", async () => {
    mocks.setTodayRecommendationPreference.mockRejectedValueOnce(new ProjectAccessError("permission_denied"));
    expect((await POST(request())).status).toBe(403);
  });
});
