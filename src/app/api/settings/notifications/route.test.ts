import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { DEFAULT_NOTIFICATION_PREFERENCES } from "@/lib/account-settings";

const mocks = vi.hoisted(() => ({ getSessionUser: vi.fn(), query: vi.fn() }));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));

import { GET, POST } from "./route";

function getRequest() {
  return new NextRequest("http://localhost/api/settings/notifications");
}

function postRequest(preferences: unknown) {
  return new NextRequest("http://localhost/api/settings/notifications", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({ preferences }),
  });
}

describe("/api/settings/notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7, name: "Егор", email: "egor@example.com", tg_id: "42" });
  });

  it("returns defaults and reports available delivery channels", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });

    const response = await GET(getRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      preferences: DEFAULT_NOTIFICATION_PREFERENCES,
      availability: { inApp: true, email: true, telegram: true },
    });
  });

  it("atomically saves only a complete preference matrix", async () => {
    const preferences = structuredClone(DEFAULT_NOTIFICATION_PREFERENCES);
    preferences.autopilot_plan.email = true;
    mocks.query.mockResolvedValueOnce({ rows: [{ updated_at: "2026-08-27T09:00:00.000Z" }] });

    const response = await POST(postRequest(preferences));

    expect(response.status).toBe(200);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("notification_preferences = excluded.notification_preferences"),
      [7, "Егор", JSON.stringify(preferences)],
    );

    const invalid = await POST(postRequest({ publication_ready: preferences.publication_ready }));
    expect(invalid.status).toBe(422);
  });
});
