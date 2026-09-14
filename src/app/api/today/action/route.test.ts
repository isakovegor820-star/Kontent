import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ProjectAccessError } from "@/lib/project-permissions";
import { TodayActionError } from "@/lib/today-actions";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  hasTrustedMutationOrigin: vi.fn(),
  performTodaySmartAction: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: mocks.hasTrustedMutationOrigin }));
vi.mock("@/lib/today-actions", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/today-actions")>();
  return { ...original, performTodaySmartAction: mocks.performTodaySmartAction };
});

import { POST } from "./route";

function request(body: unknown = {
  channelId: 11,
  fingerprint: "a".repeat(64),
  actionKind: "create_opportunity_draft",
}) {
  return new NextRequest("http://localhost/api/today/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/today/action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasTrustedMutationOrigin.mockReturnValue(true);
    mocks.getSessionUser.mockResolvedValue({ id: 9 });
    mocks.performTodaySmartAction.mockResolvedValue({ href: "/app/studio?draft=41&intent=create", created: true });
  });

  it("rejects an untrusted origin and an unauthenticated request", async () => {
    mocks.hasTrustedMutationOrigin.mockReturnValueOnce(false);
    expect((await POST(request())).status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();

    mocks.getSessionUser.mockResolvedValueOnce(null);
    expect((await POST(request())).status).toBe(401);
  });

  it("runs only an allowlisted action for the selected channel and disables caching", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.performTodaySmartAction).toHaveBeenCalledWith({
      actorUserId: 9,
      channelId: 11,
      fingerprint: "a".repeat(64),
      actionKind: "create_opportunity_draft",
    });
    expect((await POST(request({ channelId: 11, fingerprint: "a".repeat(64), actionKind: "publish_now" }))).status).toBe(422);
    expect((await POST(request({ channelId: "other-project", fingerprint: "a".repeat(64), actionKind: "create_opportunity_draft" }))).status).toBe(422);
    expect((await POST(request({ channelId: 11, fingerprint: "bad", actionKind: "create_opportunity_draft" }))).status).toBe(422);
  });

  it("preserves project isolation failures", async () => {
    mocks.performTodaySmartAction.mockRejectedValueOnce(new ProjectAccessError("permission_denied"));
    expect((await POST(request())).status).toBe(403);
  });

  it.each([
    ["action_not_found", 404],
    ["action_changed", 409],
    ["action_source_unavailable", 409],
    ["opportunity_stale", 422],
  ])("maps %s without hiding its recovery semantics", async (code, status) => {
    mocks.performTodaySmartAction.mockRejectedValueOnce(new TodayActionError(code));
    const response = await POST(request());
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: code });
  });
});
