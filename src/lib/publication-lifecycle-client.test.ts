import { setProjectTransport } from "./project-transport";
import { projectJson } from "@/test/project-response";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    const fetchMock = vi.fn().mockResolvedValue(projectJson(7, editorResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getPublicationOperationEditorContext(7)).resolves.toMatchObject({
      operationId: 7,
      draftId: 41,
      draftVersion: 3,
      scheduleRevision: 2,
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/publication-operations/7", expect.objectContaining({
      cache: "no-store", signal: expect.any(AbortSignal), headers: expect.any(Headers),
    }));
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
    const fetchMock = vi.fn().mockResolvedValue(projectJson(7, {
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
      headers: expect.any(Headers),
      body: JSON.stringify({ expectedScheduleRevision: 1, expectedStatus: "queued" }),
    }));
    const headers = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(headers.get("idempotency-key")).toBe("cancel-7");
    expect(headers.get("x-aurora-project-id")).toBe("7");
  });

  it("does not turn a 409 body into success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(projectJson(7, {
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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(projectJson(7, {
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

beforeEach(() => setProjectTransport(7, true, 5));
afterEach(() => setProjectTransport(null));
