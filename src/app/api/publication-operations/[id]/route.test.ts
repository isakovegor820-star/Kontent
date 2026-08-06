import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  cancel: vi.fn(),
  reschedule: vi.fn(),
  getJob: vi.fn(),
  reconcile: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/publication-lifecycle.mjs", () => ({
  cancelPublicationOperation: mocks.cancel,
  reschedulePublicationOperation: mocks.reschedule,
}));
vi.mock("@/lib/publication-outbox.mjs", () => ({
  reconcilePublicationOutbox: mocks.reconcile,
}));
vi.mock("@/lib/queue", () => ({
  getPublishQueue: () => ({ getJob: mocks.getJob, add: vi.fn() }),
  jobIdForPostRevision: (postId: number, revision: number) => `post-${postId}-r${revision}`,
}));

import { DELETE, PATCH } from "./route";

const context = { params: Promise.resolve({ id: "7" }) };

function request(method: "DELETE" | "PATCH", body: object, origin = "http://localhost") {
  return new NextRequest("http://localhost/api/publication-operations/7", {
    method,
    headers: {
      "content-type": "application/json",
      "idempotency-key": "lifecycle-key",
      origin,
    },
    body: JSON.stringify(body),
  });
}

describe("publication lifecycle mutation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 5 });
    mocks.getJob.mockResolvedValue(null);
  });

  it("rejects an untrusted browser origin before session or DB work", async () => {
    const response = await DELETE(request("DELETE", {}, "https://evil.example"), context);
    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("requires a session and optimistic status", async () => {
    mocks.getSessionUser.mockResolvedValueOnce(null);
    expect((await DELETE(request("DELETE", {}), context)).status).toBe(401);
    mocks.getSessionUser.mockResolvedValueOnce({ id: 5 });
    const missingStatus = await DELETE(request("DELETE", { expectedScheduleRevision: 1 }), context);
    expect(missingStatus.status).toBe(422);
    await expect(missingStatus.json()).resolves.toMatchObject({ error: "expected_status_required" });
  });

  it("preserves owner-scoped not-found and machine-readable conflict codes", async () => {
    mocks.cancel.mockResolvedValue({
      ok: false,
      error: "publication_operation_not_found",
      httpStatus: 404,
    });
    const response = await DELETE(request("DELETE", {
      expectedScheduleRevision: 1,
      expectedStatus: "queued",
    }), context);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "publication_operation_not_found" });
    expect(mocks.cancel).toHaveBeenCalledWith(expect.objectContaining({
      userId: 5,
      operationId: 7,
      expectedRevision: 1,
      expectedStatus: "queued",
      idempotencyKey: "lifecycle-key",
    }));
  });

  it("rejects PATCH actions other than reschedule", async () => {
    const response = await PATCH(request("PATCH", {
      action: "edit_payload",
      expectedScheduleRevision: 1,
      expectedStatus: "queued",
    }), context);
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: "unsupported_action" });
    expect(mocks.reschedule).not.toHaveBeenCalled();
  });

  it("rejects a forged instant before lifecycle mutation", async () => {
    const response = await PATCH(request("PATCH", {
      action: "reschedule",
      expectedScheduleRevision: 1,
      expectedStatus: "queued",
      localDate: "2026-08-20",
      localTime: "10:15",
      timezone: "Europe/Amsterdam",
      disambiguation: "reject",
      offset: "+02:00",
      scheduledAt: "2026-08-20T10:15:00.000Z",
    }), context);
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: "schedule_instant_conflict" });
    expect(mocks.reschedule).not.toHaveBeenCalled();
  });
});
