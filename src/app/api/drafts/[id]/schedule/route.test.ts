import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  rescheduleDraftForUser: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/server-drafts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server-drafts")>();
  return { ...actual, rescheduleDraftForUser: mocks.rescheduleDraftForUser };
});

import { DraftConflictError } from "@/lib/server-drafts";
import { PATCH } from "./route";

const schedule = {
  version: 3,
  scheduledAt: "2026-08-21T08:30:00.000Z",
  schedule: {
    localDate: "2026-08-21",
    localTime: "10:30",
    timezone: "Europe/Amsterdam",
    disambiguation: "reject",
    offset: "+02:00",
  },
};

describe("PATCH /api/drafts/:id/schedule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 5 });
  });

  it("updates only the parsed schedule for the signed-in actor", async () => {
    mocks.rescheduleDraftForUser.mockResolvedValue({
      id: 41,
      version: 4,
      scheduled_at: schedule.scheduledAt,
    });
    const response = await PATCH(new NextRequest("http://localhost/api/drafts/41/schedule", {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify(schedule),
    }), { params: Promise.resolve({ id: "41" }) });

    expect(response.status).toBe(200);
    expect(mocks.rescheduleDraftForUser).toHaveBeenCalledWith(5, 41, schedule);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      draft: { id: 41, version: 4, scheduled_at: schedule.scheduledAt },
    });
  });

  it("returns the current draft after a concurrent calendar change", async () => {
    mocks.rescheduleDraftForUser.mockRejectedValue(new DraftConflictError({
      id: 41,
      version: 4,
      scheduled_at: "2026-08-22T08:30:00.000Z",
    } as never));
    const response = await PATCH(new NextRequest("http://localhost/api/drafts/41/schedule", {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify(schedule),
    }), { params: Promise.resolve({ id: "41" }) });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "version_conflict",
      current: { id: 41, version: 4 },
    });
  });
});
