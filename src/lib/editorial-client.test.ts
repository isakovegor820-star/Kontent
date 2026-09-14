import { afterEach, describe, expect, it, vi } from "vitest";

import {
  approvePersonalDraftForPublication,
  decideEditorialReview,
  editorialErrorMessage,
  editorialRoleCapabilities,
  loadEditorialSnapshot,
  parseEditorialSnapshotResponse,
  submitEditorialReview,
} from "./editorial-client";

const HASH = "a".repeat(64);

const response = {
  ok: true,
  editorial: {
    workflow: {
      draftId: 41,
      projectId: 7,
      state: "in_review",
      version: 2,
      currentRevisionId: 81,
      submittedRevisionId: 81,
      approvedRevisionId: null,
      approvedContentHash: null,
      updatedAt: "2026-08-12T10:00:00.000Z",
    },
    currentRevision: {
      id: 81,
      projectId: 7,
      draftId: 41,
      draftVersion: 4,
      authorUserId: 5,
      authorName: "Анна",
      contentHash: HASH,
      snapshot: { text: "Материал" },
      createdAt: "2026-08-12T09:55:00.000Z",
    },
    request: {
      id: 12,
      revisionId: 81,
      contentHash: HASH,
      requestedByUserId: 5,
      requestedByName: "Анна",
      status: "open",
      version: 1,
      requestedAt: "2026-08-12T10:00:00.000Z",
      resolvedAt: null,
    },
    comments: [{
      id: 20,
      revisionId: 81,
      contentHash: HASH,
      authorUserId: 9,
      authorName: "Игорь",
      body: "Уточните вывод.",
      createdAt: "2026-08-12T10:05:00.000Z",
    }],
    decisions: [{
      id: 30,
      requestId: 11,
      revisionId: 80,
      contentHash: "b".repeat(64),
      actorUserId: 9,
      actorName: "Игорь",
      decision: "request_changes",
      note: "Добавьте источник.",
      createdAt: "2026-08-11T10:00:00.000Z",
    }],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("editorial client contract", () => {
  it("parses exact project, revision, comments and decision history", () => {
    expect(parseEditorialSnapshotResponse(response)).toMatchObject({
      workflow: { projectId: 7, draftId: 41, state: "in_review", version: 2 },
      currentRevision: { id: 81, authorName: "Анна", contentHash: HASH },
      request: { id: 12, requestedByName: "Анна", version: 1 },
      comments: [{ authorName: "Игорь", revisionId: 81 }],
      decisions: [{ decision: "request_changes", actorName: "Игорь" }],
    });
  });

  it("rejects incomplete or cross-linked server payloads", () => {
    expect(parseEditorialSnapshotResponse({
      ...response,
      editorial: {
        ...response.editorial,
        currentRevision: { ...response.editorial.currentRevision, projectId: 8 },
      },
    })).toBeNull();
    expect(parseEditorialSnapshotResponse({
      ...response,
      editorial: { ...response.editorial, decisions: [{ decision: "approved" }] },
    })).toBeNull();
  });

  it("sends exact revision, request and workflow versions for mutations", async () => {
    const requests: RequestInit[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const snapshot = parseEditorialSnapshotResponse(response);
    expect(snapshot).not.toBeNull();
    await submitEditorialReview(41, snapshot!);
    await decideEditorialReview(41, snapshot!, "approve", null);

    expect(JSON.parse(String(requests[0]?.body))).toEqual({
      revisionId: 81,
      contentHash: HASH,
      workflowVersion: 2,
    });
    expect(JSON.parse(String(requests[1]?.body))).toEqual({
      requestId: 12,
      requestVersion: 1,
      workflowVersion: 2,
      revisionId: 81,
      contentHash: HASH,
      decision: "approve",
      note: null,
    });
  });

  it("loads without cache and keeps role actions explicit", async () => {
    const fetchMock = vi.fn(async () => Response.json(response));
    vi.stubGlobal("fetch", fetchMock);
    await expect(loadEditorialSnapshot(41)).resolves.toMatchObject({ workflow: { draftId: 41 } });
    expect(fetchMock).toHaveBeenCalledWith("/api/drafts/41/editorial", expect.objectContaining({ cache: "no-store" }));
    expect(editorialRoleCapabilities("author")).toEqual({ canSubmit: true, canReview: false, readOnly: false });
    expect(editorialRoleCapabilities("approver")).toMatchObject({ canSubmit: true, canReview: true });
    expect(editorialRoleCapabilities("publisher")).toEqual({ canSubmit: false, canReview: false, readOnly: true });
  });

  it("turns one personal publication decision into an exact server approval", async () => {
    const draftResponse = {
      ...response,
      editorial: {
        ...response.editorial,
        workflow: {
          ...response.editorial.workflow,
          state: "draft",
          version: 1,
          submittedRevisionId: null,
        },
        request: null,
      },
    };
    const approvedResponse = {
      ...response,
      editorial: {
        ...response.editorial,
        workflow: {
          ...response.editorial.workflow,
          state: "approved",
          version: 3,
          approvedRevisionId: 81,
          approvedContentHash: HASH,
        },
        request: {
          ...response.editorial.request,
          status: "approved",
          version: 2,
          resolvedAt: "2026-08-12T10:06:00.000Z",
        },
      },
    };
    const responses = [draftResponse, { ok: true }, response, { ok: true }, approvedResponse];
    const fetchMock = vi.fn(async (...requestArgs: Parameters<typeof fetch>) => {
      void requestArgs;
      return Response.json(responses.shift());
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(approvePersonalDraftForPublication(41, 4)).resolves.toMatchObject({
      workflow: { state: "approved", approvedRevisionId: 81 },
      currentRevision: { draftVersion: 4 },
    });
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method ?? "GET"])).toEqual([
      ["/api/drafts/41/editorial", "GET"],
      ["/api/drafts/41/editorial/submit", "POST"],
      ["/api/drafts/41/editorial", "GET"],
      ["/api/drafts/41/editorial/decisions", "POST"],
      ["/api/drafts/41/editorial", "GET"],
    ]);
  });

  it("refuses to approve a different personal draft revision", async () => {
    const fetchMock = vi.fn(async () => Response.json(response));
    vi.stubGlobal("fetch", fetchMock);
    await expect(approvePersonalDraftForPublication(41, 5)).rejects.toMatchObject({
      code: "stale_revision",
      status: 409,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses actionable recovery copy without technical implementation terms", () => {
    expect(editorialErrorMessage(new Error("stale_revision"))).toContain("другой вкладке");
    expect(editorialErrorMessage(new Error("network"))).toContain("остались на экране");
    expect(editorialErrorMessage(new Error("decision_note_required"))).toContain("Опишите");
    expect(editorialErrorMessage(new Error("server"))).not.toMatch(/worker|payload|idempotency/iu);
  });
});
