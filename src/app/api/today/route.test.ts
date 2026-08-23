import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ProjectAccessError } from "@/lib/project-permissions";
import { TodayError } from "@/lib/today";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  loadTodayBoard: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/today", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/today")>();
  return { ...original, loadTodayBoard: mocks.loadTodayBoard };
});

import { GET } from "./route";

describe("GET /api/today", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 9 });
    mocks.loadTodayBoard.mockResolvedValue({ enabled: true, items: [], channels: [] });
  });

  it("passes only a positive safe channel selector to the board service", async () => {
    await GET(new NextRequest("http://localhost/api/today?channel=12"));
    expect(mocks.loadTodayBoard).toHaveBeenCalledWith({ actorUserId: 9, channelId: 12 });

    const invalid = await GET(new NextRequest("http://localhost/api/today?channel=invalid"));
    expect(invalid.status).toBe(422);
    await expect(invalid.json()).resolves.toEqual({ error: "bad_channel" });
    expect(mocks.loadTodayBoard).toHaveBeenCalledTimes(1);

    await GET(new NextRequest("http://localhost/api/today"));
    expect(mocks.loadTodayBoard).toHaveBeenLastCalledWith({ actorUserId: 9, channelId: null });
  });

  it("rejects unauthenticated requests", async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    const response = await GET(new NextRequest("http://localhost/api/today"));
    expect(response.status).toBe(401);
    expect(mocks.loadTodayBoard).not.toHaveBeenCalled();
  });

  it("reports invalid channels and project isolation without leaking data", async () => {
    mocks.loadTodayBoard.mockRejectedValueOnce(new TodayError("channel_not_found"));
    const invalid = await GET(new NextRequest("http://localhost/api/today?channel=999"));
    expect(invalid.status).toBe(404);
    await expect(invalid.json()).resolves.toEqual({ error: "channel_not_found" });

    mocks.loadTodayBoard.mockRejectedValueOnce(new ProjectAccessError("permission_denied"));
    const denied = await GET(new NextRequest("http://localhost/api/today?channel=12"));
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toEqual({ error: "access_denied" });
  });
});
