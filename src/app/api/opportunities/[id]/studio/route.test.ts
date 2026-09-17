import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getOpportunityStudioContext: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/project-route", () => ({ withProjectRoute: (handler: unknown) => handler }));
vi.mock("@/lib/content-intelligence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/content-intelligence")>();
  return { ...actual, getOpportunityStudioContext: mocks.getOpportunityStudioContext };
});

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUser.mockResolvedValue({ id: 5 });
  mocks.getOpportunityStudioContext.mockResolvedValue({
    opportunityId: 88,
    opportunityRevision: 2,
    growthMoveId: 44,
    channelId: 7,
    prompt: "trusted prompt",
    requestKey: "studio_opportunity_88_r2",
    resultClientKey: "draft_result_studio_opportunity_88_r2",
  });
});

describe("GET /api/opportunities/:id/studio", () => {
  it("returns the trusted, project-scoped generation context", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/opportunities/88/studio"),
      { params: Promise.resolve({ id: "88" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      context: expect.objectContaining({ opportunityId: 88, channelId: 7, prompt: "trusted prompt" }),
    });
    expect(mocks.getOpportunityStudioContext).toHaveBeenCalledExactlyOnceWith({
      actorUserId: 5,
      opportunityId: 88,
    });
  });

  it("rejects an invalid id before querying", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/opportunities/nope/studio"),
      { params: Promise.resolve({ id: "nope" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.getOpportunityStudioContext).not.toHaveBeenCalled();
  });
});
