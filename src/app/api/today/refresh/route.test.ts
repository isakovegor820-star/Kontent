import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  hasTrustedMutationOrigin: vi.fn(),
  refreshTodaySources: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: mocks.hasTrustedMutationOrigin }));
vi.mock("@/lib/today-refresh", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/today-refresh")>();
  return { ...original, refreshTodaySources: mocks.refreshTodaySources };
});

import { POST } from "./route";

function request(body: unknown = { channelId: 11 }) {
  return new NextRequest("http://localhost/api/today/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/today/refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasTrustedMutationOrigin.mockReturnValue(true);
    mocks.getSessionUser.mockResolvedValue({ id: 9 });
    mocks.refreshTodaySources.mockResolvedValue({ availability: "ready", sources: [], completedAt: "now" });
  });

  it("rejects an untrusted origin before reading the session", async () => {
    mocks.hasTrustedMutationOrigin.mockReturnValue(false);
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated and invalid-channel requests", async () => {
    mocks.getSessionUser.mockResolvedValueOnce(null);
    expect((await POST(request())).status).toBe(401);
    expect((await POST(request({ channelId: "other-project" }))).status).toBe(422);
    expect(mocks.refreshTodaySources).not.toHaveBeenCalled();
  });

  it("refreshes the exact selected channel and disables caching", async () => {
    const response = await POST(request({ channelId: 11 }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.refreshTodaySources).toHaveBeenCalledWith({ actorUserId: 9, channelId: 11 });
  });
});
