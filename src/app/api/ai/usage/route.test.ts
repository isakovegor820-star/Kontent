import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  aiUsedToday: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/ai-usage", () => ({
  AI_DAILY_LIMIT: 30,
  aiUsedToday: mocks.aiUsedToday,
}));

import { GET } from "./route";

const request = () => new NextRequest("http://localhost/api/ai/usage");

describe("GET /api/ai/usage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
  });

  it("returns the confirmed server counter", async () => {
    mocks.aiUsedToday.mockResolvedValue(12);

    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ used: 12, limit: 30, status: "ok" });
  });

  it("returns 503/unknown instead of a false zero when usage storage fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.aiUsedToday.mockRejectedValue(new Error("database unavailable"));

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      used: null,
      limit: 30,
      status: "unknown",
      error: "usage_unavailable",
    });
    expect(body.used).not.toBe(0);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(log).toHaveBeenCalledWith(
      "[/api/ai/usage] usage unavailable",
      { name: "Error" },
    );
    log.mockRestore();
  });
});
