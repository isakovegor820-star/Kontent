import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getProgress: vi.fn(),
  saveProgress: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/onboarding-progress", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/onboarding-progress")>();
  return {
    ...actual,
    getOnboardingProgress: mocks.getProgress,
    saveOnboardingProgress: mocks.saveProgress,
  };
});

import { GET, PATCH } from "./route";

const progress = {
  projectId: 7,
  step: 3,
  channelId: 11,
  firstDraftId: null,
  skippedFirstSource: false,
  version: 2,
  completedAt: null,
  updatedAt: "2026-08-01T12:00:00.000Z",
};

describe("/api/onboarding/progress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 17 });
    mocks.getProgress.mockResolvedValue(progress);
    mocks.saveProgress.mockResolvedValue(progress);
  });

  it("restores server-owned progress for the signed-in account", async () => {
    const response = await GET(new NextRequest("http://localhost/api/onboarding/progress"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, progress });
    expect(mocks.getProgress).toHaveBeenCalledWith(17);
  });

  it("saves only the accepted transition fields", async () => {
    const response = await PATCH(new NextRequest("http://localhost/api/onboarding/progress", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ step: 3, channelId: 11, skippedFirstSource: false }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.saveProgress).toHaveBeenCalledWith({
      userId: 17,
      step: 3,
      channelId: 11,
      skippedFirstSource: false,
    });
  });

  it("rejects untrusted project selectors and cross-origin writes", async () => {
    const unknown = await PATCH(new NextRequest("http://localhost/api/onboarding/progress", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ step: 2, projectId: 999 }),
    }));
    expect(unknown.status).toBe(400);

    const crossOrigin = await PATCH(new NextRequest("http://localhost/api/onboarding/progress", {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ step: 2 }),
    }));
    expect(crossOrigin.status).toBe(403);
    expect(mocks.saveProgress).not.toHaveBeenCalled();
  });
});
