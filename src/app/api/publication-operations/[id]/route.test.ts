import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getPool: vi.fn(),
  getSessionUser: vi.fn(),
  authorizeOperation: vi.fn(),
  cancel: vi.fn(),
  reschedule: vi.fn(),
  getJob: vi.fn(),
  reconcile: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/app/api/publication-operations/_project-authorization", async (original) => ({
  ...await original<typeof import("@/app/api/publication-operations/_project-authorization")>(),
  authorizePublicationOperation: mocks.authorizeOperation,
}));
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

import { DELETE, GET, PATCH } from "./route";
import { PublicationOperationNotFoundError } from "@/app/api/publication-operations/_project-authorization";
import { ProjectAccessError } from "@/lib/project-permissions";

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
    mocks.getPool.mockReturnValue({ query: vi.fn() });
    mocks.authorizeOperation.mockResolvedValue({ projectId: 23 });
  });

  it("rejects an untrusted browser origin before session or DB work", async () => {
    const response = await DELETE(request("DELETE", {}, "https://evil.example"), context);
    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.authorizeOperation).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("rejects an author before lifecycle mutation", async () => {
    mocks.authorizeOperation.mockRejectedValue(new ProjectAccessError("permission_denied"));
    const response = await DELETE(request("DELETE", {
      expectedScheduleRevision: 1,
      expectedStatus: "queued",
    }), context);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "forbidden" });
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("hides an operation outside the selected project", async () => {
    mocks.authorizeOperation.mockRejectedValue(new PublicationOperationNotFoundError());
    const response = await DELETE(request("DELETE", {
      expectedScheduleRevision: 1,
      expectedStatus: "queued",
    }), context);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "publication_operation_not_found" });
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
      projectId: 23,
      operationId: 7,
      expectedRevision: 1,
      expectedStatus: "queued",
      idempotencyKey: "lifecycle-key",
    }));
    expect(mocks.authorizeOperation).toHaveBeenCalledWith(expect.objectContaining({
      userId: 5,
      operationId: 7,
      permission: "content.publish",
      requireCreator: true,
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

  it("returns project-scoped operation status to an active project member", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: "7",
          draft_id: "41",
          draft_version: "3",
          status: "queued",
          scheduled_at: "2026-08-20T08:15:00.000Z",
          timezone: "Europe/Amsterdam",
          schedule_offset: "+02:00",
          schedule_disambiguation: "reject",
          schedule_revision: "2",
          created_at: "2026-08-11T10:00:00.000Z",
          updated_at: "2026-08-11T10:10:00.000Z",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          post_id: "81",
          channel_id: "12",
          network: "tg",
          title: "Практика",
          post_status: "scheduled",
          queue_status: "enqueued",
          safe_error_code: null,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: "101",
          post_id: "81",
          kind: "first_comment",
          status: "waiting_dependency",
          external_id: null,
          external_url: null,
          attempts: "0",
          last_error_code: null,
          last_error_message: null,
          completed_at: null,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: "201",
          post_id: "81",
          responsible_user_id: "5",
          review_at: "2026-09-20T08:15:00.000Z",
          timezone: "Europe/Amsterdam",
          status: "scheduled",
          decision: null,
          reminder_status: "pending",
          reminder_sent_at: null,
          update_draft_id: "301",
          network: "tg",
          can_decide: true,
          successful_pin: true,
          version: "2",
        }],
      });
    mocks.getPool.mockReturnValue({ query });

    const response = await GET(new NextRequest(
      "http://localhost/api/publication-operations/7",
    ), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      operation: {
        id: 7,
        draftId: 41,
        scheduleOffset: "+02:00",
        scheduleDisambiguation: "reject",
        scheduleRevision: 2,
        destinations: [{
          postId: 81,
          channelId: 12,
          queueStatus: "enqueued",
          extraOperations: [{ id: 101, kind: "first_comment", status: "waiting_dependency" }],
          review: {
            id: 201,
            responsibleUserId: 5,
            status: "scheduled",
            updateDraftId: 301,
            canDecide: true,
            canUnpin: true,
          },
        }],
      },
    });
    expect(mocks.authorizeOperation).toHaveBeenCalledWith(expect.objectContaining({
      userId: 5,
      operationId: 7,
      permission: "project.read",
    }));
    expect(String(query.mock.calls[0]?.[0])).toContain("project_id = $2");
    expect(query.mock.calls[0]?.[1]).toEqual([7, 23]);
  });
});
