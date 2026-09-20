import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { DraftValidationError } from "@/lib/server-drafts";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  createOpportunitySourceContext: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: () => true }));
vi.mock("@/lib/project-route", () => ({ withProjectRoute: (handler: unknown) => handler }));
vi.mock("@/lib/content-intelligence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/content-intelligence")>();
  return { ...actual, createOpportunitySourceContext: mocks.createOpportunitySourceContext };
});

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUser.mockResolvedValue({ id: 5 });
  mocks.createOpportunitySourceContext.mockResolvedValue({ draftId: 44, created: true });
});

describe("POST /api/opportunities/:id/draft", () => {
  it("creates source context for the selected opportunity", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/opportunities/88/draft", { method: "POST" }),
      { params: Promise.resolve({ id: "88" }) },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ draftId: 44, created: true });
    expect(mocks.createOpportunitySourceContext).toHaveBeenCalledWith({ actorUserId: 5, opportunityId: 88 });
  });

  it("turns a disappeared source into a recoverable conflict", async () => {
    mocks.createOpportunitySourceContext.mockRejectedValue(new DraftValidationError("source_context_not_found"));
    const response = await POST(
      new NextRequest("http://localhost/api/opportunities/88/draft", { method: "POST" }),
      { params: Promise.resolve({ id: "88" }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "opportunity_source_unavailable" });
  });
});
