import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  buildLibraryRegistrySnapshot: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/library-registry", () => ({
  buildLibraryRegistrySnapshot: mocks.buildLibraryRegistrySnapshot,
}));

import { GET } from "./route";

describe("GET /api/library/registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.buildLibraryRegistrySnapshot.mockResolvedValue({
      channelId: 11,
      channelTitle: "Канал",
      exportedAt: "2026-08-05T10:00:00.000Z",
      activeFilters: {},
      formulaVersion: "aurora-library-v1",
      items: [],
    });
  });

  it("requires authentication before building the analytical snapshot", async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    const response = await GET(new NextRequest("http://localhost/api/library/registry"));
    expect(response.status).toBe(401);
    expect(mocks.buildLibraryRegistrySnapshot).not.toHaveBeenCalled();
  });

  it("keeps user rating and objective Score filters separate", async () => {
    const response = await GET(new NextRequest(
      "http://localhost/api/library/registry?channel=11&ratingMin=4&scoreMin=80&format=photo&sort=velocity",
    ));
    expect(response.status).toBe(200);
    expect(mocks.buildLibraryRegistrySnapshot).toHaveBeenCalledWith(7, expect.objectContaining({
      channelId: 11,
      ratingMin: 4,
      scoreMin: 80,
      formats: ["photo"],
      sort: "velocity",
    }));
  });
});
