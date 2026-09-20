import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  setOpportunityState: vi.fn(),
  clearOpportunityState: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: () => true }));
vi.mock("@/lib/content-intelligence", () => ({
  setOpportunityState: mocks.setOpportunityState,
  clearOpportunityState: mocks.clearOpportunityState,
  isContentIntelligenceError: () => false,
}));

import { DELETE, POST } from "./route";

const context = { params: Promise.resolve({ id: "88" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUser.mockResolvedValue({ id: 5 });
  mocks.setOpportunityState.mockResolvedValue(undefined);
  mocks.clearOpportunityState.mockResolvedValue(undefined);
});

describe("/api/opportunities/:id/state", () => {
  it("stores a personal opportunity decision", async () => {
    const response = await POST(new NextRequest("http://localhost/api/opportunities/88/state", {
      method: "POST",
      headers: { "content-type": "application/json", "x-aurora-project-id": "7" },
      body: JSON.stringify({ state: "not_relevant", reasonCode: "wrong_topic" }),
    }), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, state: "not_relevant" });
    expect(mocks.setOpportunityState).toHaveBeenCalledExactlyOnceWith({
      actorUserId: 5,
      opportunityId: 88,
      state: "not_relevant",
      reasonCode: "wrong_topic",
    });
  });

  it("rejects unknown states before writing", async () => {
    const response = await POST(new NextRequest("http://localhost/api/opportunities/88/state", {
      method: "POST",
      headers: { "content-type": "application/json", "x-aurora-project-id": "7" },
      body: JSON.stringify({ state: "hidden_forever" }),
    }), context);

    expect(response.status).toBe(422);
    expect(mocks.setOpportunityState).not.toHaveBeenCalled();
  });

  it("clears the personal decision for undo", async () => {
    const response = await DELETE(new NextRequest("http://localhost/api/opportunities/88/state", {
      method: "DELETE",
      headers: { "x-aurora-project-id": "7" },
    }), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.clearOpportunityState).toHaveBeenCalledExactlyOnceWith({ actorUserId: 5, opportunityId: 88 });
  });
});
