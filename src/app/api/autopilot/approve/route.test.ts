import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  autopilotPlanRevisionHash,
  buildAutopilotApprovalPreview,
  hashAutopilotPreviewToken,
} from "@/lib/autopilot-approval.mjs";
import type { QualityResult } from "@/lib/post-quality.mjs";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getSessionUser: vi.fn(),
  resolveChannel: vi.fn(),
  enqueueAutopilotPost: vi.fn(),
  reclaimStaleApprovals: vi.fn(),
  claimPlan: vi.fn(),
  scheduleItem: vi.fn(),
  finalizeApproval: vi.fn(),
  abortApproval: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/autopilot", () => ({
  resolveChannel: mocks.resolveChannel,
  enqueueAutopilotPost: mocks.enqueueAutopilotPost,
}));
vi.mock("@/lib/autopilot-scheduling.mjs", () => ({
  reclaimStaleAutopilotApprovals: mocks.reclaimStaleApprovals,
  claimAutopilotPlan: mocks.claimPlan,
  scheduleAutopilotItem: mocks.scheduleItem,
  finalizeAutopilotApproval: mocks.finalizeApproval,
  abortAutopilotApproval: mocks.abortApproval,
}));

import { POST } from "./route";

const passedQuality: QualityResult = {
  score: 92,
  threshold: 85,
  passed: true,
  blockers: [],
  violations: [],
  metrics: { chars: 1000, emojiCount: 0, hashtagCount: 0, supportCount: 1, citedShare: 1 },
  semantic: {
    version: 1,
    status: "passed",
    passed: true,
    requiresReview: false,
    blockers: [],
    claimVerdicts: [{
      claimId: "claim-1", claim: "Проверенный текст", verdict: "supported",
      reasonCode: "entailed_by_source", riskCodes: [],
      sourceSpans: [{ sourceId: "qa-source", start: 0, end: 20 }],
    }],
    provenance: {
      validatorVersion: "semantic-publication-v1",
      checkedAt: "2026-08-02T09:30:00.000Z",
      provider: "qa-nli-v1",
      model: "qa-entailment-v1",
      sourceIds: ["qa-source"],
      rejectedSourceSpans: [],
      terminalVerdict: "passed",
    },
  },
  metadata: {
    checkedAt: "2026-08-02T09:30:00.000Z",
    rules: { id: "aurora-post-quality", version: 1, profileVersion: 1 },
    provenance: {
      kind: "deterministic",
      validator: "validatePostQuality",
      trigger: "generation",
      humanAttestation: null,
    },
  },
};

const previewToken = "abcdefghijklmnop";
let confirmationItems: ReturnType<typeof planItem>[] = [];

const confirmRequest = (idempotencyKey = "web-test-key-1") =>
  new NextRequest("http://localhost/api/autopilot/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      channelId: 7,
      action: "confirm",
      planId: 44,
      idempotencyKey,
      previewToken,
      planRevision: 1,
      previewHash: autopilotPlanRevisionHash({
        items: confirmationItems,
        planId: 44,
        planRevision: 1,
        channelId: 7,
      }),
    }),
  });

function planItem(i: number, overrides: Record<string, unknown> = {}) {
  return {
    i,
    scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    topic: `Тема ${i + 1}`,
    draft: `Проверенный текст ${i + 1}`,
    status: "pending",
    quality: passedQuality,
    ...overrides,
  };
}

function approvalDb(
  items: ReturnType<typeof planItem>[],
  replay: unknown = null,
  options: {
    currentItems?: ReturnType<typeof planItem>[];
    currentRevision?: number;
    currentStatus?: string;
  } = {},
) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  confirmationItems = items;
  const currentItems = options.currentItems ?? items;
  const currentRevision = options.currentRevision ?? 1;
  const currentStatus = options.currentStatus ?? "pending";
  const preview = buildAutopilotApprovalPreview({
    items,
    channel: { id: 7, title: "Канал А", handle: "channel_a" },
    planId: 44,
    planRevision: 1,
  });
  mocks.claimPlan.mockResolvedValue({ id: "44", items: currentItems, edited: false, channel_id: "7", revision: "2" });
  mocks.query.mockImplementation(async (sqlValue: string, params: unknown[] = []) => {
    const sql = sqlValue.replace(/\s+/g, " ").trim();
    calls.push({ sql, params });
    if (sql.includes("select id, title, handle from channels")) {
      return { rows: [{ id: "7", title: "Канал А", handle: "channel_a" }], rowCount: 1 };
    }
    if (sql.includes("from autopilot_approval_operations where user_id")) {
      return { rows: replay ? [replay] : [], rowCount: replay ? 1 : 0 };
    }
    if (sql.includes("from autopilot_approval_previews")) {
      return {
        rows: [{ snapshot: preview, plan_revision: "1", preview_hash: preview.hash }],
        rowCount: 1,
      };
    }
    if (sql.includes("select id, items, revision from autopilot_plan")) {
      return currentStatus === "pending"
        ? { rows: [{ id: "44", items: currentItems, revision: String(currentRevision) }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes("select items, revision, status from autopilot_plan")) {
      return {
        rows: [{ items: currentItems, revision: String(currentRevision), status: currentStatus }],
        rowCount: 1,
      };
    }
    if (sql.startsWith("insert into autopilot_approval_operations")) {
      return { rows: [{ id: "91" }], rowCount: 1 };
    }
    if (sql.startsWith("update autopilot_approval_previews")) {
      return { rows: [{ token_hash: hashAutopilotPreviewToken(previewToken) }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUser.mockResolvedValue({ id: 3 });
  mocks.resolveChannel.mockResolvedValue(7);
  mocks.reclaimStaleApprovals.mockResolvedValue([]);
  mocks.finalizeApproval.mockResolvedValue(true);
  mocks.abortApproval.mockResolvedValue(true);
  mocks.scheduleItem.mockImplementation(async ({ index }: { index: number }) => ({
    postId: 501 + index,
    scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    queuePending: false,
  }));
});

describe("POST /api/autopilot/approve", () => {
  it("persists an opaque preview token with the canonical revision and hash", async () => {
    const items = [planItem(0)];
    const calls = approvalDb(items);
    const response = await POST(new NextRequest("http://localhost/api/autopilot/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId: 7, action: "preview" }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.preview).toMatchObject({ planId: 44, revision: 1, counts: { eligible: 1 } });
    expect(body.preview.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.preview.token).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    const stored = calls.find((call) => call.sql.startsWith("insert into autopilot_approval_previews"));
    expect(stored?.params).toEqual(expect.arrayContaining([
      3,
      7,
      44,
      1,
      body.preview.hash,
    ]));
    expect(String(stored?.params[0])).not.toBe(body.preview.token);
  });

  it("rejects a changed plan revision before operation, post, outbox, or queue side effects", async () => {
    const original = [planItem(0)];
    const changed = [{ ...original[0], draft: "Текст изменён после preview" }];
    const calls = approvalDb(original, null, { currentItems: changed, currentRevision: 2 });

    const response = await POST(confirmRequest("web-stale-key"));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({ ok: false, error: "stale_preview" });
    expect(body.preview).toMatchObject({ revision: 2 });
    expect(calls.some((call) => call.sql.startsWith("insert into autopilot_approval_operations"))).toBe(false);
    expect(mocks.claimPlan).not.toHaveBeenCalled();
    expect(mocks.scheduleItem).not.toHaveBeenCalled();
  });

  it("turns three expired items into explicit expired drafts without creating posts/jobs", async () => {
    const calls = approvalDb(
      [0, 1, 2].map((i) =>
        planItem(i, { scheduledAt: new Date(Date.now() - (i + 1) * 60_000).toISOString() }),
      ),
    );

    const response = await POST(confirmRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, scheduled: 0, expired: 3, blocked: 0 });
    expect(mocks.scheduleItem).not.toHaveBeenCalled();
    const finalized = mocks.finalizeApproval.mock.calls[0][0];
    expect(finalized.planStatus).toBe("pending");
    expect(finalized.items.map((item: { status: string }) => item.status)).toEqual([
      "expired",
      "expired",
      "expired",
    ]);
    expect(mocks.claimPlan).toHaveBeenCalledWith(expect.anything(), {
      planId: 44,
      userId: 3,
      channelId: 7,
      operationId: 91,
      allowedStatuses: ["pending"],
      expectedRevision: 1,
    });
    const audit = calls.find((call) => call.sql.startsWith("insert into autopilot_approval_operations"));
    expect(audit?.params.slice(0, 6)).toEqual([
      3,
      7,
      44,
      1,
      expect.stringMatching(/^[a-f0-9]{64}$/),
      "web-test-key-1",
    ]);
  });

  it("blocks a missing quality result with a stable, understandable reason", async () => {
    approvalDb([planItem(0, { quality: undefined })]);

    const response = await POST(confirmRequest("web-test-key-2"));
    const body = await response.json();

    expect(body).toMatchObject({ ok: true, scheduled: 0, blocked: 1, expired: 0 });
    expect(body.blockerDetails[0].reasons[0]).toMatchObject({ code: "quality_missing" });
    expect(mocks.scheduleItem).not.toHaveBeenCalled();
  });

  it("replays the stored result for the same idempotency key without touching the plan", async () => {
    const stored = {
      channel_id: "7",
      plan_id: "44",
      plan_revision: "1",
      preview_hash: autopilotPlanRevisionHash({
        items: [],
        planId: 44,
        planRevision: 1,
        channelId: 7,
      }),
      http_status: 200,
      result: {
        ok: true,
        scheduled: 1,
        blocked: 0,
        expired: 0,
        planId: 44,
        channel: { id: 7, title: "Канал А", handle: "channel_a" },
      },
    };
    const calls = approvalDb([], stored);

    const response = await POST(confirmRequest("web-replay-key"));
    const body = await response.json();

    expect(body).toEqual(stored.result);
    expect(mocks.scheduleItem).not.toHaveBeenCalled();
    expect(mocks.claimPlan).not.toHaveBeenCalled();
    expect(calls.some((call) => call.sql.startsWith("insert into autopilot_approval_operations"))).toBe(false);
  });

  it("returns and persists an exact retry-safe partial state after a checkpoint DB failure", async () => {
    approvalDb([planItem(0), planItem(1), planItem(2)]);
    mocks.scheduleItem
      .mockResolvedValueOnce({ postId: 501, scheduledAt: planItem(0).scheduledAt, queuePending: false })
      .mockRejectedValueOnce(new Error("checkpoint db failure"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(confirmRequest("web-partial-key"));
    const body = await response.json();
    errorLog.mockRestore();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      error: "queue_unavailable",
      scheduled: 1,
      partial: true,
      retryable: true,
      remaining: { eligible: 2 },
    });
    const finalized = mocks.finalizeApproval.mock.calls[0][0];
    expect(finalized).toMatchObject({ planStatus: "pending", operationStatus: "partial", httpStatus: 503 });
    const savedItems = finalized.items;
    expect(savedItems[0]).toMatchObject({ status: "approved", postId: 501 });
    expect(savedItems[1]).toMatchObject({ status: "pending" });
    expect(savedItems[2]).toMatchObject({ status: "pending" });
  });

  it("commits every durable checkpoint and reports queue reconciliation without failing approval", async () => {
    approvalDb([planItem(0), planItem(1)]);
    mocks.scheduleItem
      .mockResolvedValueOnce({ postId: 501, scheduledAt: planItem(0).scheduledAt, queuePending: true })
      .mockResolvedValueOnce({ postId: 502, scheduledAt: planItem(1).scheduledAt, queuePending: false });

    const response = await POST(confirmRequest("web-outbox-key"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      scheduled: 2,
      queuePendingReconciliation: 1,
      reconciliationPending: true,
    });
    expect(mocks.finalizeApproval).toHaveBeenCalledWith(expect.objectContaining({
      planStatus: "approved",
      operationStatus: "completed",
      items: expect.arrayContaining([
        expect.objectContaining({ i: 0, status: "approved", postId: 501 }),
        expect.objectContaining({ i: 1, status: "approved", postId: 502 }),
      ]),
    }));
  });

  it("stops before any DB mutation when the requested channel is not owned", async () => {
    mocks.resolveChannel.mockResolvedValue(null);

    const response = await POST(confirmRequest("web-channel-key"));

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ ok: false, error: "no_channel" });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.scheduleItem).not.toHaveBeenCalled();
  });
});
