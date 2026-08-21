// Д.9 — безопасное массовое одобрение плана.
// Сначала сервер возвращает точный preview, затем принимает отдельный confirm с idempotency key.

import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { enqueueAutopilotPost, resolveChannel } from "@/lib/autopilot";
import {
  autopilotPlanRevisionHash,
  buildAutopilotApprovalPreview,
  createAutopilotPreviewToken,
  executeAutopilotApproval,
  hashAutopilotPreviewToken,
  type ApprovalBlocker,
  type AutopilotApprovalPreview,
} from "@/lib/autopilot-approval.mjs";
import {
  abortAutopilotApproval,
  claimAutopilotPlan,
  finalizeAutopilotApproval,
  reclaimStaleAutopilotApprovals,
  scheduleAutopilotItem,
} from "@/lib/autopilot-scheduling.mjs";
import type { QualityResult } from "@/lib/post-quality.mjs";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { ProjectAccessError, requireSelectedProjectPermission } from "@/lib/project-permissions";

export const runtime = "nodejs";

interface PlanItem {
  i: number;
  scheduledAt: string;
  topic: string;
  draft: string;
  status: string;
  postId?: number;
  invented?: string[];
  qualityBlocked?: boolean;
  quality?: QualityResult;
  approvalBlockers?: ApprovalBlocker[];
}

interface RequestBody {
  channelId?: unknown;
  action?: unknown;
  planId?: unknown;
  idempotencyKey?: unknown;
  previewToken?: unknown;
  planRevision?: unknown;
  previewHash?: unknown;
}

interface OperationResult {
  ok: boolean;
  error?: string;
  scheduled: number;
  blocked: number;
  expired: number;
  partial?: boolean;
  retryable?: boolean;
  already?: boolean;
  planId: number;
  channel: AutopilotApprovalPreview["channel"];
  remaining?: AutopilotApprovalPreview["counts"];
  blockerDetails?: AutopilotApprovalPreview["blockers"];
  queuePendingReconciliation?: number;
  reconciliationPending?: boolean;
}

const validKey = (value: unknown) => {
  const key = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9._:-]{8,128}$/.test(key) ? key : null;
};

const validPreviewToken = (value: unknown) => {
  const token = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_-]{16,64}$/.test(token) ? token : null;
};

const validPreviewHash = (value: unknown) => {
  const hash = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-f0-9]{64}$/.test(hash) ? hash : null;
};

function projectIdempotencyKey(projectId: number, clientKey: string): string {
  const prefix = `project:${projectId}:`;
  if (prefix.length + clientKey.length <= 128) return `${prefix}${clientKey}`;
  return `${prefix}sha256:${createHash("sha256").update(clientKey).digest("hex")}`;
}

function approvalSemantics(preview: AutopilotApprovalPreview) {
  return JSON.stringify({
    counts: preview.counts,
    dates: preview.dates,
    blockers: preview.blockers,
  });
}

async function createStoredPreview(
  pool: ReturnType<typeof getPool>,
  projectId: number,
  userId: number,
  channel: AutopilotApprovalPreview["channel"],
) {
  const plan = (
    await pool.query<{ id: string; items: PlanItem[]; revision: string }>(
      `select id, items, revision from autopilot_plan
        where project_id = $1 and channel_id = $2 and status = 'pending'
        order by created_at desc limit 1`,
      [projectId, channel.id],
    )
  ).rows[0];
  if (!plan) return null;

  const preview = buildAutopilotApprovalPreview({
    items: plan.items,
    nowMs: Date.now(),
    channel,
    planId: Number(plan.id),
    planRevision: Number(plan.revision),
    actor: "human",
  });
  const token = createAutopilotPreviewToken();
  await pool.query(
    `insert into autopilot_approval_previews
       (token_hash, project_id, user_id, channel_id, plan_id, plan_revision, preview_hash, snapshot, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
    [
      hashAutopilotPreviewToken(token),
      projectId,
      userId,
      channel.id,
      preview.planId,
      preview.revision,
      preview.hash,
      JSON.stringify(preview),
      preview.expiresAt,
    ],
  );
  return { ...preview, token };
}

async function finishOperation(
  operationId: number,
  projectId: number,
  userId: number,
  status: "completed" | "partial" | "failed",
  result: unknown,
  httpStatus: number,
) {
  await getPool().query(
    `update autopilot_approval_operations
        set status = $4, result = $5, http_status = $6, completed_at = now()
      where id = $1 and project_id = $2 and user_id = $3`,
    [operationId, projectId, userId, status, JSON.stringify(result), httpStatus],
  );
}

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  let operationId: number | null = null;
  let authorizedProjectId: number | null = null;
  let claimedContext: { planId: number; projectId: number; userId: number; channelId: number } | null = null;
  let fallbackChannel: AutopilotApprovalPreview["channel"] | null = null;
  try {
    const pool = getPool();
    const membership = await requireSelectedProjectPermission(pool, user.id, "content.publish");
    const projectId = membership.projectId;
    authorizedProjectId = projectId;
    const channelId = await resolveChannel(
      { actorUserId: user.id, projectId },
      Number(body.channelId) || null,
    );
    if (!channelId) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });

    const channel = (
      await pool.query<{ id: string; title: string | null; handle: string | null }>(
        `select id, title, handle from channels
          where id = $1 and project_id = $2 and network = 'tg' and is_active = true`,
        [channelId, projectId],
      )
    ).rows[0];
    if (!channel) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });
    const channelSnapshot = { ...channel, id: Number(channel.id) };
    fallbackChannel = channelSnapshot;

    // A process may have died after a durable per-item checkpoint. Reclaim first so the
    // old idempotency key receives a terminal retryable result and a new key can continue.
    await reclaimStaleAutopilotApprovals(pool, { projectId, channelId });

    const action = body.action === "confirm" ? "confirm" : "preview";
    if (action === "preview") {
      const preview = await createStoredPreview(pool, projectId, user.id, channelSnapshot);
      if (!preview) return NextResponse.json({ ok: true, preview: null, already: true });
      return NextResponse.json({ ok: true, preview });
    }

    const planId = Number(body.planId);
    const idempotencyKey = validKey(body.idempotencyKey);
    const previewToken = validPreviewToken(body.previewToken);
    const planRevision = Number(body.planRevision);
    const previewHash = validPreviewHash(body.previewHash);
    if (
      !Number.isInteger(planId) || planId <= 0 || !idempotencyKey || !previewToken ||
      !Number.isSafeInteger(planRevision) || planRevision <= 0 || !previewHash
    ) {
      return NextResponse.json({ ok: false, error: "bad_confirmation" }, { status: 422 });
    }
    const scopedIdempotencyKey = projectIdempotencyKey(projectId, idempotencyKey);

    // A completed key always replays its stored result. It cannot be reused for another
    // channel or plan, which prevents an accidental cross-channel confirmation.
    const replay = (
      await pool.query<{
        channel_id: string;
        plan_id: string | null;
        plan_revision: string | null;
        preview_hash: string | null;
        result: OperationResult | null;
        http_status: number;
      }>(
        `select channel_id, plan_id, plan_revision, preview_hash, result, http_status
           from autopilot_approval_operations
          where project_id = $1 and user_id = $2 and idempotency_key = $3`,
        [projectId, user.id, scopedIdempotencyKey],
      )
    ).rows[0];
    if (replay) {
      if (
        Number(replay.channel_id) !== channelId || Number(replay.plan_id) !== planId ||
        Number(replay.plan_revision) !== planRevision || replay.preview_hash !== previewHash
      ) {
        return NextResponse.json({ ok: false, error: "idempotency_conflict" }, { status: 409 });
      }
      if (replay.result) {
        return NextResponse.json(replay.result, { status: replay.http_status });
      }
      return NextResponse.json({ ok: false, error: "approval_in_progress" }, { status: 409 });
    }

    const previewRecord = (
      await pool.query<{
        snapshot: AutopilotApprovalPreview;
        plan_revision: string;
        preview_hash: string;
      }>(
        `select snapshot, plan_revision, preview_hash
           from autopilot_approval_previews
          where token_hash = $1 and project_id = $2 and user_id = $3
            and channel_id = $4 and plan_id = $5
            and consumed_at is null and expires_at > now()`,
        [hashAutopilotPreviewToken(previewToken), projectId, user.id, channelId, planId],
      )
    ).rows[0];

    const currentPlan = (
      await pool.query<{ items: PlanItem[]; revision: string; status: string }>(
        `select items, revision, status from autopilot_plan
          where id = $1 and project_id = $2 and channel_id = $3`,
        [planId, projectId, channelId],
      )
    ).rows[0];
    const currentRevision = Number(currentPlan?.revision);
    const currentHash = currentPlan
      ? autopilotPlanRevisionHash({
          items: currentPlan.items,
          planId,
          planRevision: currentRevision,
          channelId,
        })
      : null;
    const currentPreview = currentPlan
      ? buildAutopilotApprovalPreview({
          items: currentPlan.items,
          nowMs: Date.now(),
          channel: channelSnapshot,
          planId,
          planRevision: currentRevision,
          actor: "human",
        })
      : null;
    const previewIsStale =
      !previewRecord || !currentPlan || currentPlan.status !== "pending" ||
      Number(previewRecord.plan_revision) !== planRevision || previewRecord.preview_hash !== previewHash ||
      currentRevision !== planRevision || currentHash !== previewHash ||
      !currentPreview || approvalSemantics(currentPreview) !== approvalSemantics(previewRecord.snapshot);
    if (previewIsStale) {
      const freshPreview = await createStoredPreview(pool, projectId, user.id, channelSnapshot);
      return NextResponse.json(
        { ok: false, error: "stale_preview", preview: freshPreview },
        { status: 409 },
      );
    }

    const operation = await pool.query<{ id: string }>(
      `insert into autopilot_approval_operations
         (project_id, user_id, channel_id, plan_id, plan_revision, preview_hash,
          idempotency_key, actor_type, status, request_snapshot)
       values ($1, $2, $3, $4, $5, $6, $7, 'web', 'processing', $8)
       on conflict do nothing
       returning id`,
      [
        projectId,
        user.id,
        channelId,
        planId,
        planRevision,
        previewHash,
        scopedIdempotencyKey,
        JSON.stringify(previewRecord.snapshot),
      ],
    );
    if (!operation.rowCount) {
      return NextResponse.json({ ok: false, error: "approval_in_progress" }, { status: 409 });
    }
    operationId = Number(operation.rows[0].id);

    const consumed = await pool.query(
      `update autopilot_approval_previews
          set consumed_at = now(), operation_id = $3
        where token_hash = $1 and project_id = $2
          and consumed_at is null and expires_at > now()
        returning token_hash`,
      [hashAutopilotPreviewToken(previewToken), projectId, operationId],
    );
    if (!consumed.rowCount) {
      const freshPreview = await createStoredPreview(pool, projectId, user.id, channelSnapshot);
      const result = { ok: false, error: "stale_preview", preview: freshPreview };
      await finishOperation(operationId, projectId, user.id, "failed", result, 409);
      return NextResponse.json(result, { status: 409 });
    }

    // Claim the exact plan for this user AND channel. A second key or another tab cannot
    // schedule the same items while this operation is running.
    const plan = await claimAutopilotPlan(pool, {
      planId,
      projectId,
      userId: user.id,
      channelId,
      operationId,
      allowedStatuses: ["pending"],
      expectedRevision: planRevision,
    }) as { id: string; items: PlanItem[]; edited: boolean; channel_id: string; revision: string } | null;
    if (!plan) {
      const freshPreview = await createStoredPreview(pool, projectId, user.id, channelSnapshot);
      const result = { ok: false, error: "stale_preview", preview: freshPreview };
      await finishOperation(operationId, projectId, user.id, "failed", result, 409);
      return NextResponse.json(result, { status: 409 });
    }
    claimedContext = { planId, projectId, userId: user.id, channelId };
    const approvalTime = Date.now();
    const preview = buildAutopilotApprovalPreview({
      items: plan.items,
      nowMs: approvalTime,
      channel: channelSnapshot,
      planId,
      planRevision: Number(plan.revision || planRevision + 1),
      actor: "human",
    });
    await pool.query(
      `update autopilot_approval_operations
          set request_snapshot = $4
        where id = $1 and project_id = $2 and user_id = $3`,
      [operationId, projectId, user.id, JSON.stringify(preview)],
    );

    let queuePendingReconciliation = 0;
    const outcome = await executeAutopilotApproval({
      items: plan.items,
      nowMs: approvalTime,
      attestor: { userId: user.id, attestedAt: new Date(approvalTime).toISOString() },
      schedule: async (item) => {
        const checkpoint = await scheduleAutopilotItem({
          pool,
          enqueue: enqueueAutopilotPost,
          planId,
          projectId,
          userId: user.id,
          channelId,
          operationId: operationId!,
          index: item.i,
          approvedItem: item,
          nowMs: approvalTime,
        });
        if (checkpoint.queuePending) queuePendingReconciliation += 1;
        return checkpoint.postId;
      },
    });
    const items = outcome.items as PlanItem[];
    const scheduled = outcome.scheduled;
    if (outcome.error) {
      const remaining = buildAutopilotApprovalPreview({
        items,
        nowMs: Date.now(),
        channel: channelSnapshot,
        planId,
        planRevision: Number(plan.revision || planRevision + 1),
        actor: "human",
      });
      const result: OperationResult = {
        ok: false,
        error: "scheduling_failed",
        scheduled,
        blocked: preview.counts.blocked,
        expired: preview.counts.expired,
        partial: scheduled > 0,
        retryable: true,
        planId,
        channel: channelSnapshot,
        remaining: remaining.counts,
        blockerDetails: preview.blockers,
      };
      await finalizeAutopilotApproval({
        pool,
        planId,
        projectId,
        userId: user.id,
        channelId,
        operationId,
        items,
        planStatus: "pending",
        operationStatus: scheduled > 0 ? "partial" : "failed",
        result,
        httpStatus: 503,
      });
      claimedContext = null;
      console.error("[/api/autopilot/approve] checkpoint", outcome.error);
      return NextResponse.json(result, { status: 503 });
    }

    const unresolved = items.some((it) => it.status === "pending" || it.status === "expired");

    const result: OperationResult = {
      ok: true,
      scheduled,
      blocked: preview.counts.blocked,
      expired: preview.counts.expired,
      planId,
      channel: channelSnapshot,
      blockerDetails: preview.blockers,
      queuePendingReconciliation,
      reconciliationPending: queuePendingReconciliation > 0,
    };
    await finalizeAutopilotApproval({
      pool,
      planId,
      projectId,
      userId: user.id,
      channelId,
      operationId,
      items,
      planStatus: unresolved ? "pending" : "approved",
      operationStatus: "completed",
      result,
      httpStatus: 200,
      streakEligible: scheduled > 0 && !unresolved,
      edited: plan.edited,
    });
    claimedContext = null;
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/autopilot/approve]", err);
    if (operationId) {
      const fallback: OperationResult = {
        ok: false,
        error: "server",
        scheduled: 0,
        blocked: 0,
        expired: 0,
        retryable: true,
        planId: Number(body.planId) || 0,
        channel: fallbackChannel ?? { id: Number(body.channelId) || 0, title: null, handle: null },
      };
      if (claimedContext) {
        await abortAutopilotApproval({
          pool: getPool(),
          ...claimedContext,
          operationId,
          result: fallback,
          httpStatus: 500,
        }).catch(() => {});
      } else if (authorizedProjectId) {
        await finishOperation(
          operationId,
          authorizedProjectId,
          user.id,
          "failed",
          fallback,
          500,
        ).catch(() => {});
      }
    }
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
