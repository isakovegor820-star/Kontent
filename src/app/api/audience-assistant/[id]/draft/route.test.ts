import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), discard: vi.fn(), rate: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.rate, rateLimitResponse: () => new Response(null, { status: 429 }) }));
vi.mock("@/lib/audience-assistant", async (original) => ({
  ...await original<typeof import("@/lib/audience-assistant")>(), discardAudienceReply: mocks.discard,
}));
import { AudienceAssistantError } from "@/lib/audience-assistant";
import { DELETE } from "./route";
const context = { params: Promise.resolve({ id: "41" }) };
function request(body: unknown = { expectedVersion: 2 }, origin = "http://localhost") {
  return new NextRequest("http://localhost/api/audience-assistant/41/draft", {
    method: "DELETE", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ id: 3 });
  mocks.rate.mockResolvedValue({ allowed: true });
  mocks.discard.mockResolvedValue({ id: 41, status: "pending", suggestedReply: null, version: 3 });
});
describe("DELETE audience draft", () => {
  it("requires authentication", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await DELETE(request(), context)).status).toBe(401);
    expect(mocks.discard).not.toHaveBeenCalled();
  });
  it("rejects a cross-site deletion", async () => {
    expect((await DELETE(request(undefined, "https://attacker.example"), context)).status).toBe(403);
    expect(mocks.discard).not.toHaveBeenCalled();
  });
  it("does not accept a client project or user override", async () => {
    expect((await DELETE(request({ expectedVersion: 2, projectId: 999 }), context)).status).toBe(400);
    expect(mocks.discard).not.toHaveBeenCalled();
  });
  it("passes the authenticated actor and version to the deletion transaction", async () => {
    const response = await DELETE(request(), context);
    expect(response.status).toBe(200);
    expect(mocks.discard).toHaveBeenCalledWith({ actorUserId: 3, inquiryId: 41, expectedVersion: 2 });
    expect(await response.json()).toMatchObject({ ok: true, inquiry: { suggestedReply: null, status: "pending" } });
  });
  it("returns an actionable conflict while delivery is in progress", async () => {
    mocks.discard.mockRejectedValue(new AudienceAssistantError("delivery_in_progress"));
    const response = await DELETE(request(), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "delivery_in_progress" });
  });
});
