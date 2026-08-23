import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  loadTodayBoard: vi.fn(),
  loadTodayNavigationAvailability: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/today", () => ({
  loadTodayBoard: mocks.loadTodayBoard,
  loadTodayNavigationAvailability: mocks.loadTodayNavigationAvailability,
}));

import { GET } from "./route";

describe("GET /api/today", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 9 });
    mocks.loadTodayNavigationAvailability.mockResolvedValue({ visible: true });
    mocks.loadTodayBoard.mockResolvedValue({ enabled: true, items: [], channels: [] });
  });

  it("uses the lightweight availability path for navigation", async () => {
    const response = await GET(new NextRequest(
      "http://localhost/api/today?summary=availability",
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ visible: true });
    expect(mocks.loadTodayNavigationAvailability).toHaveBeenCalledWith(9);
    expect(mocks.loadTodayBoard).not.toHaveBeenCalled();
  });

  it("passes only a positive safe channel selector to the board service", async () => {
    await GET(new NextRequest("http://localhost/api/today?channel=12"));
    expect(mocks.loadTodayBoard).toHaveBeenCalledWith({ actorUserId: 9, channelId: 12 });

    await GET(new NextRequest("http://localhost/api/today?channel=invalid"));
    expect(mocks.loadTodayBoard).toHaveBeenLastCalledWith({ actorUserId: 9, channelId: null });
  });
});
