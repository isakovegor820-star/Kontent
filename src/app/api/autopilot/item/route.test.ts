import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  getSessionUser: vi.fn(),
  resolveChannel: vi.fn(),
  enqueueAutopilotPost: vi.fn(),
  reclaimStaleApprovals: vi.fn(),
  claimPlan: vi.fn(),
  scheduleItem: vi.fn(),
  finalizeApproval: vi.fn(),
  abortApproval: vi.fn(),
  getJob: vi.fn(),
  removeJob: vi.fn(),
  requireSelectedProjectPermission: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getPool: () => ({ query: mocks.query, connect: mocks.connect }),
}));
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
  resolvedAutopilotPlanStatus: (items: Array<{ status?: string }>) =>
    items.some((item) => item.status === "pending" || item.status === "expired")
      ? "pending"
      : "approved",
}));
vi.mock("@/lib/queue", () => ({
  getPublishQueue: () => ({ getJob: mocks.getJob }),
  jobIdForPost: (id: number) => `post-${id}`,
}));
vi.mock("@/lib/project-permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-permissions")>();
  return { ...actual, requireSelectedProjectPermission: mocks.requireSelectedProjectPermission };
});

import { PATCH } from "./route";

const quality = {
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

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getSessionUser.mockResolvedValue({ id: 3 });
  mocks.requireSelectedProjectPermission.mockResolvedValue({
    projectId: 88,
    userId: 3,
    role: "publisher",
    version: 1,
  });
  mocks.resolveChannel.mockResolvedValue(7);
  mocks.reclaimStaleApprovals.mockResolvedValue([]);
  mocks.finalizeApproval.mockResolvedValue(true);
  mocks.abortApproval.mockResolvedValue(true);
});

const approvedItem = {
  i: 2,
  scheduledAt: "2026-08-03T12:00:00.000Z",
  topic: "Одобренная тема",
  draft: "Запланированный текст",
  status: "approved",
  postId: 501,
  quality,
};

const planBinding = { planId: 44, planRevision: 3, itemId: 2 };

function rejectRequest() {
  return new NextRequest("http://localhost/api/autopilot/item", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channelId: 7, index: 2, action: "reject", ...planBinding }),
  });
}

function mockOwnedPlan() {
  mocks.query.mockResolvedValue({
    rows: [{ id: 44, items: [{ ...approvedItem }], channel_id: 7, status: "approved", revision: 3 }],
    rowCount: 1,
  });
}

function mockTransaction(
  implementation: (sql: string, params: unknown[]) => Promise<unknown>,
) {
  mocks.clientQuery.mockImplementation((sqlValue: string, params: unknown[] = []) =>
    implementation(sqlValue.replace(/\s+/g, " ").trim(), params),
  );
  mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
}

describe("PATCH /api/autopilot/item approve", () => {
  it("persists an expired status and never shifts the item to now + 120 seconds", async () => {
    const originalDate = new Date(Date.now() - 60_000).toISOString();
    const source = [{
      i: 2,
      scheduledAt: originalDate,
      topic: "Просроченная тема",
      draft: "Проверенный текст",
      status: "pending",
      quality,
    }];
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    mocks.claimPlan.mockResolvedValue({ items: source, channel_id: 7 });
    mocks.query.mockImplementation(async (sqlValue: string, params: unknown[] = []) => {
      const sql = sqlValue.replace(/\s+/g, " ").trim();
      calls.push({ sql, params });
      if (sql.startsWith("select id, items, channel_id, status, revision from autopilot_plan")) {
        return { rows: [{ id: 44, items: source, channel_id: 7, status: "pending" }], rowCount: 1 };
      }
      if (sql.includes("from autopilot_approval_operations where project_id")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("insert into autopilot_approval_operations")) {
        return { rows: [{ id: 91 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    const response = await PATCH(
      new NextRequest("http://localhost/api/autopilot/item", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelId: 7,
          index: 2,
          action: "approve",
          idempotencyKey: "item-expired-key",
          ...planBinding,
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body).toMatchObject({ ok: false, error: "approval_blocked", status: "expired" });
    expect(body.blockerDetails[0]).toMatchObject({ code: "expired" });
    expect(mocks.scheduleItem).not.toHaveBeenCalled();
    const finalized = mocks.finalizeApproval.mock.calls[0][0];
    const savedItem = finalized.items[0];
    expect(savedItem).toMatchObject({ status: "expired", scheduledAt: originalDate });
    expect(finalized).toMatchObject({ planStatus: "pending", operationStatus: "completed", httpStatus: 422 });
    const operation = calls.find((call) => call.sql.startsWith("insert into autopilot_approval_operations"));
    expect(operation?.params.slice(0, 5)).toEqual([
      88,
      3,
      7,
      44,
      "project:88:item-expired-key",
    ]);
    expect(mocks.claimPlan).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      projectId: 88,
      planId: 44,
      channelId: 7,
    }));
  });

  it("returns success with the durable post id when queue reconciliation is pending", async () => {
    const source = [{
      ...approvedItem,
      status: "pending",
      postId: undefined,
      scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    }];
    mocks.claimPlan.mockResolvedValue({ items: source, channel_id: 7 });
    mocks.scheduleItem.mockResolvedValue({
      postId: 501,
      scheduledAt: source[0].scheduledAt,
      queuePending: true,
    });
    mocks.query.mockImplementation(async (sqlValue: string) => {
      const sql = sqlValue.replace(/\s+/g, " ").trim();
      if (sql.startsWith("select id, items, channel_id, status, revision from autopilot_plan")) {
        return { rows: [{ id: 44, items: source, channel_id: 7, status: "pending" }], rowCount: 1 };
      }
      if (sql.includes("from autopilot_approval_operations where project_id")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("insert into autopilot_approval_operations")) {
        return { rows: [{ id: 91 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    const response = await PATCH(
      new NextRequest("http://localhost/api/autopilot/item", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelId: 7,
          index: 2,
          action: "approve",
          idempotencyKey: "item-outbox-key",
          ...planBinding,
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      postId: 501,
      reconciliationPending: true,
    });
    expect(mocks.finalizeApproval).toHaveBeenCalledWith(expect.objectContaining({
      planStatus: "approved",
      operationStatus: "completed",
      items: [expect.objectContaining({ status: "approved", postId: 501 })],
    }));
  });
});

describe("PATCH /api/autopilot/item reject", () => {
  it("rejects a stale plan revision instead of applying the item index to the latest plan", async () => {
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });

    const response = await PATCH(rejectRequest());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "stale_plan" });
    expect(mocks.getJob).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("id = $3 and revision = $4"),
      [88, 7, 44, 3],
    );
  });

  it("fails closed when the publish queue cannot confirm whether the job exists", async () => {
    mockOwnedPlan();
    mocks.getJob.mockRejectedValue(new Error("redis unavailable"));

    const response = await PATCH(rejectRequest());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "cancel_unavailable",
      retryable: true,
    });
    expect(mocks.getJob).toHaveBeenCalledWith("post-501");
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("does not delete or reject the item when removing its job fails", async () => {
    mockOwnedPlan();
    mocks.getJob.mockResolvedValue({ remove: mocks.removeJob });
    mocks.removeJob.mockRejectedValue(new Error("job is active"));

    const response = await PATCH(rejectRequest());

    expect(response.status).toBe(503);
    expect(mocks.removeJob).toHaveBeenCalledOnce();
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("returns a conflict when the worker wins the scheduled-to-publishing race", async () => {
    mockOwnedPlan();
    mocks.getJob.mockResolvedValue(null);
    const transactionCalls: Array<{ sql: string; params: unknown[] }> = [];
    mockTransaction(async (sql, params) => {
      transactionCalls.push({ sql, params });
      if (sql.startsWith("delete from posts")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: null };
    });

    const response = await PATCH(rejectRequest());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "cancel_conflict",
      retryable: true,
    });
    const deletion = transactionCalls.find((call) => call.sql.startsWith("delete from posts"));
    expect(deletion?.sql).toContain(
      "where id = $1 and project_id = $2 and channel_id = $3 and status = 'scheduled'",
    );
    expect(deletion?.params).toEqual([501, 88, 7]);
    expect(transactionCalls.some((call) => call.sql.startsWith("update autopilot_plan"))).toBe(false);
    expect(transactionCalls.at(-1)?.sql).toBe("rollback");
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("commits rejection only after cancelling the owned channel post", async () => {
    mockOwnedPlan();
    mocks.getJob.mockResolvedValue({ remove: mocks.removeJob });
    mocks.removeJob.mockResolvedValue(undefined);
    const transactionCalls: Array<{ sql: string; params: unknown[] }> = [];
    mockTransaction(async (sql, params) => {
      transactionCalls.push({ sql, params });
      if (sql.startsWith("delete from posts")) return { rows: [{ id: 501 }], rowCount: 1 };
      if (sql.startsWith("update autopilot_plan")) return { rows: [{ id: 44 }], rowCount: 1 };
      return { rows: [], rowCount: null };
    });

    const response = await PATCH(rejectRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    const saved = transactionCalls.find((call) => call.sql.startsWith("update autopilot_plan"));
    expect(saved?.sql).toContain("where id = $1 and project_id = $2 and channel_id = $3");
    expect(saved?.params.slice(0, 3)).toEqual([44, 88, 7]);
    expect(JSON.parse(String(saved?.params[3]))[0]).toMatchObject({
      i: 2,
      postId: 501,
      status: "rejected",
    });
    expect(transactionCalls.at(-1)?.sql).toBe("commit");
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});

describe("PATCH /api/autopilot/item edit quality provenance", () => {
  it("records an edit recheck as deterministic automation, never as manual review", async () => {
    const source = [{
      ...approvedItem,
      status: "pending",
      postId: undefined,
      draft: "Старый текст",
      qualityOrigin: "manual_review",
    }];
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    mocks.query.mockImplementation(async (sqlValue: string, params: unknown[] = []) => {
      const sql = sqlValue.replace(/\s+/g, " ").trim();
      calls.push({ sql, params });
      if (sql.startsWith("select id, items, channel_id, status, revision from autopilot_plan")) {
        return { rows: [{ id: 44, items: source, channel_id: 7, status: "pending" }], rowCount: 1 };
      }
      if (sql.startsWith("select quality from content_brief")) {
        return { rows: [{ quality: { preset: "expert" } }], rowCount: 1 };
      }
      if (sql.startsWith("update autopilot_plan")) {
        return { rows: [{ revision: 4 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    const response = await PATCH(
      new NextRequest("http://localhost/api/autopilot/item", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelId: 7,
          index: 2,
          action: "edit",
          draft: "Новый текст после редактирования.",
          ...planBinding,
        }),
      }),
    );

    expect(response.status).toBe(200);
    const saved = calls.find((call) =>
      call.sql.startsWith("update autopilot_plan set items = $5::jsonb, edited = edited or $6"),
    );
    const savedItem = JSON.parse(String(saved?.params[4]))[0];
    expect(savedItem.qualityOrigin).toBe("automatic");
    expect(savedItem.quality.metadata).toMatchObject({
      rules: { id: "aurora-post-quality", version: 1, profileVersion: 1 },
      provenance: {
        kind: "deterministic",
        validator: "validatePostQuality",
        trigger: "edit_recheck",
        humanAttestation: null,
      },
    });
    expect(Number.isFinite(Date.parse(savedItem.quality.metadata.checkedAt))).toBe(true);
  });
});
