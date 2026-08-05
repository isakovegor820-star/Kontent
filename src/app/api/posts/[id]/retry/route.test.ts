import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  add: vi.fn(),
  getSessionUser: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/queue", () => ({
  getPublishQueue: () => ({ add: mocks.add }),
  jobIdForPostRevision: (id: number, revision: number) => `post-${id}-r${revision}`,
}));

import { POST } from "./route";

function request(key = "qa-retry-key") {
  return new NextRequest("http://localhost/api/posts/41/retry", {
    method: "POST",
    headers: { "idempotency-key": key },
  });
}

describe("POST /api/posts/:id/retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T12:00:00.000Z"));
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.add.mockResolvedValue({ id: "job" });
  });

  it("requires an owned quarantined row and creates a future revision-bound job", async () => {
    mocks.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: "41", schedule_revision: "2", scheduled_at: "2026-08-02T12:02:00Z" }],
    });
    const response = await POST(request(), { params: Promise.resolve({ id: "41" }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      scheduledAt: "2026-08-02T12:02:00.000Z",
      scheduleRevision: 2,
    });
    expect(String(mocks.query.mock.calls[0][0])).toContain("status in ('failed', 'quarantined')");
    expect(String(mocks.query.mock.calls[0][0])).toContain("schedule_revision = schedule_revision + 1");
    expect(mocks.add).toHaveBeenCalledWith(
      "publish",
      { postId: 41, scheduleRevision: 2 },
      expect.objectContaining({ delay: 120_000, jobId: expect.stringContaining("post-41-r2-manual-") }),
    );
  });

  it("compensates a queue failure without leaving a hidden scheduled row", async () => {
    mocks.query
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: "41", schedule_revision: "5", scheduled_at: "2026-08-02T12:02:00Z" }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    mocks.add.mockRejectedValueOnce(new Error("redis unavailable"));
    const response = await POST(request(), { params: Promise.resolve({ id: "41" }) });
    expect(response.status).toBe(500);
    expect(String(mocks.query.mock.calls[1][0])).toContain("schedule_revision = $4");
  });
});

