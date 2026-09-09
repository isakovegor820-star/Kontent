import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ user: vi.fn(), query: vi.fn(), queue: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.user }));
vi.mock("@/lib/db", () => ({ getPool: mocks.query }));
vi.mock("@/lib/queue", () => ({ getPublishQueue: mocks.queue }));
import { POST } from "./route";

function request(body: unknown = {}, origin = "http://localhost") {
  return new NextRequest("http://localhost/api/posts/create", {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue({ id: 5 }); });
describe("retired direct-publication endpoint", () => {
  it.each(["manual", "rss", "autopilot", "ai"])("cannot publish arbitrary text with origin %s", async (origin) => {
    const response = await POST(request({ channelId: 11, text: "Unapproved text", origin, scheduledAt: new Date().toISOString() }));
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ ok: false, error: "publication_operation_required", replacement: "/api/publication-operations" });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.queue).not.toHaveBeenCalled();
  });
  it("also redirects old draft-based callers to the approval operation", async () => {
    expect((await POST(request({ draftId: 41, draftVersion: 3, text: "Old client" }))).status).toBe(410);
  });
  it("keeps authentication and origin checks", async () => {
    expect((await POST(request({}, "https://foreign.example"))).status).toBe(403);
    mocks.user.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(401);
  });
});
