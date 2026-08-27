import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cancelPublication,
  getPublicationOperationEditorContext,
  parsePublicationOperationEditorContext,
  publicationEditorMutationKind,
  publicationOperationIsSettled,
  reschedulePublication,
  restorePublicationToDraft,
} from "./publication-lifecycle-client";

afterEach(() => vi.unstubAllGlobals());

describe("publication lifecycle client", () => {
  const editorResponse = (postStatus = "scheduled") => ({
    ok: true,
    operation: {
      id: 7,
      draftId: 41,
      draftVersion: 3,
      status: "queued",
      scheduledAt: "2026-08-29T10:00:00.000Z",
      timezone: "Europe/Saratov",
      scheduleRevision: 2,
      scheduleOffset: "+04:00",
      scheduleDisambiguation: "reject",
      destinations: [{ postId: 81, postStatus }],
    },
  });

  it("loads a strict editor context for the publication-linked draft", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(editorResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getPublicationOperationEditorContext(7)).resolves.toMatchObject({
      operationId: 7,
      draftId: 41,
      draftVersion: 3,
      scheduleRevision: 2,
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/publication-operations/7", {
      cache: "no-store",
      signal: undefined,
    });
  });

  it("rejects malformed editor contexts and recognizes delivered destinations", () => {
    expect(parsePublicationOperationEditorContext({
      ...editorResponse(),
      operation: { ...editorResponse().operation, draftId: "41" },
    })).toMatchObject({ draftId: 41 });
    expect(parsePublicationOperationEditorContext({
      ...editorResponse(),
      operation: { ...editorResponse().operation, scheduleDisambiguation: "guess" },
    })).toBeNull();
    const published = parsePublicationOperationEditorContext(editorResponse("published"));
    expect(published && publicationOperationIsSettled(published)).toBe(true);
    expect(published && publicationEditorMutationKind(published, 41, 3)).toBe("clone_required");
    expect(published && publicationEditorMutationKind(published, 41, 4)).toBe("replace");
    const scheduled = parsePublicationOperationEditorContext(editorResponse());
    expect(scheduled && publicationEditorMutationKind(scheduled, 41, 3)).toBe("reschedule");
    expect(scheduled && publicationEditorMutationKind(scheduled, 41, 4)).toBe("replace");
  });

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
