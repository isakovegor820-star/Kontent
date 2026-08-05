import { describe, expect, it, vi } from "vitest";

import {
  abortAutopilotApproval,
  autopilotItemOperationKey,
  claimAutopilotPlan,
  finalizeAutopilotApproval,
  reclaimStaleAutopilotApprovals,
  reconcileAutopilotScheduleOutbox,
  scheduleAutopilotItem,
} from "./autopilot-scheduling.mjs";

const passedQuality = {
  score: 92,
  threshold: 85,
  passed: true,
  blockers: [],
  violations: [],
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

const scheduledAt = "2026-08-03T12:00:00.000Z";
const sourceItems = () => [{
  i: 0,
  scheduledAt,
  topic: "Тема",
  draft: "Проверенный текст",
  status: "pending",
  quality: passedQuality,
}];

function checkpointPool({
  failPlanUpdate = false,
  failDispatchAck = false,
  items = sourceItems(),
} = {}) {
  const state = {
    items: structuredClone(items),
    post: null,
    outbox: null,
    postInsertions: 0,
    commits: 0,
    rollbacks: 0,
  };
  const statements = [];
  const release = vi.fn();
  const connect = vi.fn(async () => {
    let working = structuredClone(state);
    return {
      release,
      query: vi.fn(async (sqlValue, params = []) => {
        const sql = String(sqlValue).replace(/\s+/g, " ").trim();
        statements.push(sql);
        if (sql === "begin") {
          working = structuredClone(state);
          return { rows: [], rowCount: null };
        }
        if (sql.includes("select items from autopilot_plan")) {
          return { rows: [{ items: structuredClone(working.items) }], rowCount: 1 };
        }
        if (sql.includes("from autopilot_schedule_outbox o") && sql.includes("for update of o")) {
          return { rows: working.outbox ? [structuredClone(working.outbox)] : [], rowCount: working.outbox ? 1 : 0 };
        }
        if (sql.startsWith("insert into posts")) {
          if (working.post) return { rows: [], rowCount: 0 };
          working.postInsertions += 1;
          working.post = {
            id: 501,
            scheduled_at: params[3],
            status: "scheduled",
            idempotency_key: params[4],
            request_fingerprint: params[5],
          };
          return { rows: [structuredClone(working.post)], rowCount: 1 };
        }
        if (sql.includes("from posts") && sql.includes("idempotency_key")) {
          return { rows: working.post ? [structuredClone(working.post)] : [], rowCount: working.post ? 1 : 0 };
        }
        if (sql.startsWith("select status, schedule_revision from posts")) {
          return {
            rows: working.post ? [{ status: working.post.status, schedule_revision: 1 }] : [],
            rowCount: working.post ? 1 : 0,
          };
        }
        if (sql.startsWith("insert into autopilot_schedule_outbox")) {
          if (!working.outbox) {
            working.outbox = {
              id: 71,
              post_id: working.post.id,
              scheduled_at: working.post.scheduled_at,
              status: "pending",
              post_status: working.post.status,
            };
          }
          return { rows: [structuredClone(working.outbox)], rowCount: 1 };
        }
        if (sql.startsWith("update autopilot_plan") && sql.includes("approval_heartbeat_at")) {
          if (failPlanUpdate) throw new Error("checkpoint db failure");
          working.items = JSON.parse(String(params[4]));
          return { rows: [{ id: 44 }], rowCount: 1 };
        }
        if (sql === "commit") {
          Object.assign(state, structuredClone(working));
          state.commits += 1;
          return { rows: [], rowCount: null };
        }
        if (sql === "rollback") {
          state.rollbacks += 1;
          return { rows: [], rowCount: null };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
  });
  const query = vi.fn(async (sqlValue, params = []) => {
    const sql = String(sqlValue).replace(/\s+/g, " ").trim();
    if (sql.startsWith("update autopilot_schedule_outbox")) {
      if (failDispatchAck) throw new Error("ack db failure");
      if (state.outbox) {
        state.outbox.status = params[1] ? "enqueued" : "pending";
        state.outbox.post_status = state.post?.status ?? "scheduled";
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("from autopilot_schedule_outbox o") && sql.includes("order by o.updated_at")) {
      return { rows: state.outbox ? [structuredClone(state.outbox)] : [], rowCount: state.outbox ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { pool: { connect, query }, state, release, statements };
}

const scheduleInput = (pool, enqueue) => ({
  pool,
  enqueue,
  planId: 44,
  userId: 3,
  channelId: 7,
  operationId: 91,
  index: 0,
  nowMs: Date.parse("2026-08-02T12:00:00.000Z"),
});

describe("transactional Autopilot scheduling", () => {
  it("persists one post/checkpoint before enqueue and replays the same outcome after a crash window", async () => {
    const { pool, state, statements } = checkpointPool();
    const enqueue = vi.fn()
      .mockRejectedValueOnce(new Error("process died before queue acknowledgement"))
      .mockResolvedValueOnce(undefined);

    const first = await scheduleAutopilotItem(scheduleInput(pool, enqueue));
    expect(first).toMatchObject({ postId: 501, queuePending: true });
    expect(state.postInsertions).toBe(1);
    expect(state.post.idempotency_key).toBe("autopilot:44:item:0");
    expect(state.items[0]).toMatchObject({ status: "approved", postId: 501 });
    expect(state.outbox).toMatchObject({ post_id: 501, status: "pending" });

    const replay = await scheduleAutopilotItem(scheduleInput(pool, enqueue));
    expect(replay).toMatchObject({ postId: 501, queuePending: false });
    expect(state.postInsertions).toBe(1);
    expect(enqueue).toHaveBeenNthCalledWith(1, 501, scheduledAt, 1);
    expect(enqueue).toHaveBeenNthCalledWith(2, 501, scheduledAt, 1);
    expect(state.outbox.status).toBe("enqueued");
    const planLock = statements.find((sql) => sql.startsWith("select items from autopilot_plan"));
    expect(planLock).toContain("c.network = 'tg' and c.is_active = true");
  });

  it("keeps the committed outcome retryable when DB acknowledgement fails after enqueue", async () => {
    const { pool, state } = checkpointPool({ failDispatchAck: true });
    const enqueue = vi.fn().mockResolvedValue(undefined);

    const result = await scheduleAutopilotItem(scheduleInput(pool, enqueue));

    expect(result).toMatchObject({ postId: 501, queuePending: true });
    expect(state.items[0]).toMatchObject({ status: "approved", postId: 501 });
    expect(state.outbox.status).toBe("pending");
    expect(state.postInsertions).toBe(1);
  });

  it("rolls back both post and checkpoint when the transactional plan checkpoint fails", async () => {
    const { pool, state } = checkpointPool({ failPlanUpdate: true });
    const enqueue = vi.fn();

    await expect(scheduleAutopilotItem(scheduleInput(pool, enqueue))).rejects.toThrow(
      "checkpoint db failure",
    );
    expect(state.post).toBeNull();
    expect(state.outbox).toBeNull();
    expect(state.items[0]).toMatchObject({ status: "pending" });
    expect(state.items[0]).not.toHaveProperty("postId");
    expect(state.rollbacks).toBe(1);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rechecks the fail-closed quality policy inside the checkpoint transaction", async () => {
    const unsafe = sourceItems();
    delete unsafe[0].quality;
    const { pool, state } = checkpointPool({ items: unsafe });
    const enqueue = vi.fn();

    await expect(scheduleAutopilotItem(scheduleInput(pool, enqueue))).rejects.toMatchObject({
      code: "AUTOPILOT_ITEM_BLOCKED",
      blockers: expect.arrayContaining([expect.objectContaining({ code: "quality_missing" })]),
    });

    expect(state.post).toBeNull();
    expect(state.outbox).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("re-dispatches pending outbox rows with the same post identity", async () => {
    const { pool, state } = checkpointPool();
    const failed = vi.fn().mockRejectedValue(new Error("redis down"));
    await scheduleAutopilotItem(scheduleInput(pool, failed));
    const enqueue = vi.fn().mockResolvedValue(undefined);

    const result = await reconcileAutopilotScheduleOutbox({ pool, enqueue });

    expect(result).toEqual({ scanned: 1, enqueued: 1, pending: 0 });
    expect(enqueue).toHaveBeenCalledWith(501, scheduledAt, 1);
    expect(state.postInsertions).toBe(1);
    expect(state.outbox.status).toBe("enqueued");
  });
});

describe("Autopilot approval lease", () => {
  it("uses a deterministic item identity and fences the plan with operation_id", async () => {
    expect(autopilotItemOperationKey(44, 2)).toBe("autopilot:44:item:2");
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 44 }], rowCount: 1 });

    await claimAutopilotPlan({ query }, {
      planId: 44,
      userId: 3,
      channelId: 7,
      operationId: 91,
      allowedStatuses: ["pending", "approved"],
      expectedRevision: 11,
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("approval_operation_id = $4"),
      [44, 3, 7, 91, ["pending", "approved"], 11],
    );
    expect(query.mock.calls[0][0]).toContain("c.network = 'tg' and c.is_active = true");
    expect(query.mock.calls[0][0]).toContain("revision = $6");
    expect(query.mock.calls[0][0]).toContain("revision = revision + 1");
  });

  it("atomically rolls back plan finalization when the operation result cannot be stored", async () => {
    const calls = [];
    const query = vi.fn(async (sqlValue) => {
      const sql = String(sqlValue).replace(/\s+/g, " ").trim();
      calls.push(sql);
      if (sql.startsWith("update autopilot_plan")) return { rows: [{ id: 44 }], rowCount: 1 };
      if (sql.startsWith("update autopilot_approval_operations")) throw new Error("audit db error");
      return { rows: [], rowCount: null };
    });
    const release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ query, release })) };

    await expect(finalizeAutopilotApproval({
      pool,
      planId: 44,
      userId: 3,
      channelId: 7,
      operationId: 91,
      items: sourceItems(),
      planStatus: "pending",
      operationStatus: "failed",
      result: { ok: false },
      httpStatus: 500,
    })).rejects.toThrow("audit db error");

    expect(calls.at(-1)).toBe("rollback");
    expect(release).toHaveBeenCalledOnce();
  });

  it("reclaims stale approving plans and terminalizes their processing operation", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ id: 44, next_status: "pending", scheduled_count: 1, remaining_count: 2 }],
    });

    const rows = await reclaimStaleAutopilotApprovals(
      { query },
      { userId: 3, channelId: 7, leaseSeconds: 300 },
    );

    expect(rows).toHaveLength(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("for update of p skip locked");
    expect(sql).toContain("approval_operation_id = null");
    expect(sql).toContain("'approval_interrupted'");
    expect(sql).toContain("op.status = 'processing'");
    expect(params).toEqual([300, 3, 7]);
  });

  it("derives partial abort audit state from durable checkpoints, not caller memory", async () => {
    const calls = [];
    const query = vi.fn(async (sqlValue, params = []) => {
      const sql = String(sqlValue).replace(/\s+/g, " ").trim();
      calls.push({ sql, params });
      if (sql.startsWith("select items from autopilot_plan")) {
        return { rows: [{ items: [{ ...sourceItems()[0], status: "approved", postId: 501 }] }], rowCount: 1 };
      }
      if (sql.startsWith("select count(*)::int as count")) {
        return { rows: [{ count: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ query, release })) };

    await abortAutopilotApproval({
      pool,
      planId: 44,
      userId: 3,
      channelId: 7,
      operationId: 91,
      result: { ok: false, error: "server", scheduled: 0, retryable: true },
      httpStatus: 500,
    });

    const operationUpdate = calls.find(({ sql }) =>
      sql.startsWith("update autopilot_approval_operations"),
    );
    expect(operationUpdate.params[1]).toBe("partial");
    expect(JSON.parse(operationUpdate.params[2])).toMatchObject({
      scheduled: 1,
      partial: true,
      retryable: true,
    });
    expect(calls.at(-1).sql).toBe("commit");
    expect(release).toHaveBeenCalledOnce();
  });
});
