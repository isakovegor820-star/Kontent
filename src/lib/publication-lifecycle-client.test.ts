import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cancelPublication,
  reschedulePublication,
  restorePublicationToDraft,
} from "./publication-lifecycle-client";

afterEach(() => vi.unstubAllGlobals());

describe("publication lifecycle client", () => {
  it("sends revision, status and idempotency for cancel", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      ok: true,
      status: "cancelled",
      scheduleRevision: 2,
    }));
    vi.stubGlobal("fetch", fetchMock);
    await cancelPublication({
      operationId: 7,
      expectedScheduleRevision: 1,
      expectedStatus: "queued",
      idempotencyKey: "cancel-7",
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/publication-operations/7", expect.objectContaining({
      method: "DELETE",
      headers: expect.objectContaining({ "idempotency-key": "cancel-7" }),
      body: JSON.stringify({ expectedScheduleRevision: 1, expectedStatus: "queued" }),
    }));
  });

  it("does not turn a 409 body into success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      ok: false,
      error: "publication_in_progress",
    }, { status: 409 })));
    await expect(reschedulePublication({
      operationId: 7,
      expectedScheduleRevision: 1,
      expectedStatus: "queued",
      idempotencyKey: "move-7",
      scheduledAt: "2026-08-07T10:00:00.000Z",
      localDate: "2026-08-07",
      localTime: "10:00",
      timezone: "UTC",
      disambiguation: "reject",
      offset: "+00:00",
    })).resolves.toMatchObject({ ok: false, error: "publication_in_progress" });
  });

  it("restores only the server-confirmed draft id", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      ok: true,
      draftId: 91,
      draftVersion: 1,
    })));
    await expect(restorePublicationToDraft({
      operationId: 7,
      expectedScheduleRevision: 2,
      expectedStatus: "cancelled",
      idempotencyKey: "edit-7",
    })).resolves.toMatchObject({ ok: true, draftId: 91 });
  });
});
