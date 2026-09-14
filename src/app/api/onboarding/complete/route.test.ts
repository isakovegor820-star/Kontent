import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  completeOnboarding: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/onboarding-progress", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/onboarding-progress")>();
  return { ...actual, completeOnboarding: mocks.completeOnboarding };
});

import { OnboardingProgressError } from "@/lib/onboarding-progress";
import { POST } from "./route";

function request(
  body: unknown = { channelId: 11, draftId: 41 },
  headers: Record<string, string> = {},
) {
  return new NextRequest("http://localhost/api/onboarding/complete", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/onboarding/complete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 17 });
    mocks.completeOnboarding.mockResolvedValue({
      onboardingCompletedAt: "2026-08-01T12:00:00.000Z",
      progress: {
        projectId: 7,
        step: 5,
        channelId: 11,
        firstDraftId: 41,
        skippedFirstSource: false,
        version: 5,
        completedAt: "2026-08-01T12:00:00.000Z",
        updatedAt: "2026-08-01T12:00:00.000Z",
      },
    });
  });

  it("rejects an explicit cross-origin browser mutation before auth", async () => {
    const response = await POST(request(undefined, { origin: "https://evil.example" }));

    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.completeOnboarding).not.toHaveBeenCalled();
  });

  it("requires an authenticated account", async () => {
    mocks.getSessionUser.mockResolvedValue(null);

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(mocks.completeOnboarding).not.toHaveBeenCalled();
  });

  it("rejects completion without authoritative channel and material ids", async () => {
    const response = await POST(request({ channelId: 11 }));

    expect(response.status).toBe(400);
    expect(mocks.completeOnboarding).not.toHaveBeenCalled();
  });

  it("returns the server timestamp only after every invariant passes", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      onboardingCompletedAt: "2026-08-01T12:00:00.000Z",
      progress: { step: 5, channelId: 11, firstDraftId: 41 },
    });
    expect(mocks.completeOnboarding).toHaveBeenCalledWith({
      userId: 17,
      channelId: 11,
      draftId: 41,
    });
  });

  it("does not turn an incomplete workflow into a false success", async () => {
    mocks.completeOnboarding.mockRejectedValue(new OnboardingProgressError("material_required"));

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "material_required" });
  });

  it("fails closed when storage is unavailable", async () => {
    mocks.completeOnboarding.mockRejectedValue(new Error("database offline"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(request());
    errorLog.mockRestore();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "unavailable" });
  });
});
