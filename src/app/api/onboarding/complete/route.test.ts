import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));

import { POST } from "./route";

function request(headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/onboarding/complete", {
    method: "POST",
    headers,
  });
}

describe("POST /api/onboarding/complete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 17 });
    mocks.query.mockResolvedValue({
      rows: [{ onboarding_completed_at: "2026-08-01T12:00:00.000Z" }],
      rowCount: 1,
    });
  });

  it("rejects an explicit cross-origin browser mutation before auth or DB", async () => {
    const response = await POST(request({ origin: "https://evil.example" }));

    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("requires an authenticated account", async () => {
    mocks.getSessionUser.mockResolvedValue(null);

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("persists completion idempotently and returns the authoritative timestamp", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      onboardingCompletedAt: "2026-08-01T12:00:00.000Z",
    });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("coalesce(onboarding_completed_at, now())"),
      [17],
    );
  });

  it("does not claim success when session storage or the database is unavailable", async () => {
    mocks.getSessionUser.mockRejectedValue(new Error("database offline"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(request());
    errorLog.mockRestore();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "unavailable" });
  });
});
