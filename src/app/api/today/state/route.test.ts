import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ProjectAccessError } from "@/lib/project-permissions";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  hasTrustedMutationOrigin: vi.fn(),
  updateTodayItemState: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/request-origin", () => ({
  hasTrustedMutationOrigin: mocks.hasTrustedMutationOrigin,
}));
vi.mock("@/lib/today", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/today")>();
  return { ...original, updateTodayItemState: mocks.updateTodayItemState };
});

import { POST } from "./route";

function request(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/today/state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/today/state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasTrustedMutationOrigin.mockReturnValue(true);
    mocks.getSessionUser.mockResolvedValue({ id: 9 });
    mocks.updateTodayItemState.mockResolvedValue(undefined);
  });

  it("rejects an invalid channel before the state service is called", async () => {
    const response = await POST(request({
      channelId: "not-a-channel",
      fingerprint: "a".repeat(64),
      state: "snoozed",
    }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "bad_channel" });
    expect(mocks.updateTodayItemState).not.toHaveBeenCalled();
  });

  it("accepts active as an explicit undo operation", async () => {
    const response = await POST(request({
      channelId: 11,
      fingerprint: "b".repeat(64),
      state: "active",
    }));

    expect(response.status).toBe(200);
    expect(mocks.updateTodayItemState).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 9,
      channelId: 11,
      state: "active",
    }));
  });

  it("accepts done as an explicit persisted state", async () => {
    const response = await POST(request({
      channelId: 11,
      fingerprint: "c".repeat(64),
      state: "done",
    }));
    expect(response.status).toBe(200);
    expect(mocks.updateTodayItemState).toHaveBeenCalledWith(expect.objectContaining({ state: "done" }));
  });

  it("rejects untrusted, unauthenticated and access-denied mutations", async () => {
    mocks.hasTrustedMutationOrigin.mockReturnValueOnce(false);
    expect((await POST(request({ channelId: 11, fingerprint: "a".repeat(64), state: "done" }))).status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();

    mocks.getSessionUser.mockResolvedValueOnce(null);
    expect((await POST(request({ channelId: 11, fingerprint: "a".repeat(64), state: "done" }))).status).toBe(401);

    mocks.updateTodayItemState.mockRejectedValueOnce(new ProjectAccessError("permission_denied"));
    expect((await POST(request({ channelId: 11, fingerprint: "a".repeat(64), state: "done" }))).status).toBe(403);
  });

  it("rejects the legacy permanent-dismiss state", async () => {
    const response = await POST(request({
      channelId: 11,
      fingerprint: "d".repeat(64),
      state: "dismissed",
    }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "bad_state" });
    expect(mocks.updateTodayItemState).not.toHaveBeenCalled();
  });
});
