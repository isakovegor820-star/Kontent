import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  hasAuroraAdminAccess: vi.fn(),
  retryAdminPublication: vi.fn(),
  cancelAdminPublication: vi.fn(),
  rescheduleAdminPublication: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/admin-access", () => ({ hasAuroraAdminAccess: mocks.hasAuroraAdminAccess }));
vi.mock("@/lib/admin-publications", () => ({
  retryAdminPublication: mocks.retryAdminPublication,
  cancelAdminPublication: mocks.cancelAdminPublication,
  rescheduleAdminPublication: mocks.rescheduleAdminPublication,
}));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: vi.fn(), connect: vi.fn() }) }));
vi.mock("@/lib/queue", () => ({ getPublishQueue: () => ({ add: vi.fn() }) }));

import { POST } from "./route";

function request(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/admin/publications/actions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/publications/actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 3, email: "admin@example.com" });
    mocks.hasAuroraAdminAccess.mockReturnValue(true);
  });

  it("rejects cross-site requests before touching the session", async () => {
    const response = await POST(request({ action: "retry", postId: 5 }, { origin: "https://attacker.example", "sec-fetch-site": "cross-site" }));
    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
  });

  it("is admin-only", async () => {
    mocks.hasAuroraAdminAccess.mockReturnValue(false);
    const response = await POST(request({ action: "retry", postId: 5 }));
    expect(response.status).toBe(403);
    expect(mocks.retryAdminPublication).not.toHaveBeenCalled();
  });

  it("retries a validated post id and returns the queued revision with a request id", async () => {
    mocks.retryAdminPublication.mockResolvedValue({ status: "queued", postId: 5, scheduleRevision: 4, scheduledAt: "2026-09-02T15:00:00.000Z" });
    const response = await POST(request({ action: "retry", postId: 5 }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({ status: "queued", postId: 5, scheduleRevision: 4 });
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(mocks.retryAdminPublication).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ actorUserId: 3, postId: 5 }));
    expect((await POST(request({ action: "retry", postId: "abc" }))).status).toBe(400);
  });

  it("maps domain outcomes to HTTP statuses", async () => {
    mocks.cancelAdminPublication.mockResolvedValueOnce({ status: "in_progress" });
    expect((await POST(request({ action: "cancel", postId: 5 }))).status).toBe(409);
    mocks.cancelAdminPublication.mockResolvedValueOnce({ status: "not_found" });
    expect((await POST(request({ action: "cancel", postId: 5 }))).status).toBe(404);
    mocks.retryAdminPublication.mockResolvedValueOnce({ status: "queue_unavailable" });
    expect((await POST(request({ action: "retry", postId: 5 }))).status).toBe(503);
    mocks.rescheduleAdminPublication.mockResolvedValueOnce({ status: "invalid_time" });
    expect((await POST(request({ action: "reschedule", postId: 5, scheduledAt: "2020-01-01T00:00:00.000Z" }))).status).toBe(422);
  });

  it("requires a string time for reschedule and rejects unknown actions", async () => {
    expect((await POST(request({ action: "reschedule", postId: 5 }))).status).toBe(422);
    expect(mocks.rescheduleAdminPublication).not.toHaveBeenCalled();
    expect((await POST(request({ action: "delete", postId: 5 }))).status).toBe(400);
  });
});
