import { createHash } from "node:crypto";

import { evaluateAutopilotItem } from "./autopilot-approval.mjs";
import { sanitizeAutopilotPublicText } from "./autopilot-publication.mjs";

export const AUTOPILOT_APPROVAL_LEASE_SECONDS = 300;

const operationStatuses = new Set(["completed", "partial", "failed"]);
const planStatuses = new Set(["pending", "approved"]);

export class AutopilotApprovalLeaseLostError extends Error {
  constructor() {
    super("autopilot approval lease lost");
    this.name = "AutopilotApprovalLeaseLostError";
    this.code = "AUTOPILOT_APPROVAL_LEASE_LOST";
  }
}

export class AutopilotScheduleBlockedError extends Error {
  constructor(blockers = []) {
    super("autopilot item is not eligible");
    this.name = "AutopilotScheduleBlockedError";
    this.code = "AUTOPILOT_ITEM_BLOCKED";
    this.blockers = blockers;
  }
}

const positiveInteger = (value, label) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`invalid ${label}`);
  return number;
};

const itemIndex = (value) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError("invalid item index");
  return number;
};

const cloneItems = (value) =>
  (Array.isArray(value) ? value : []).map((item) => ({ ...item }));

function approvalSnapshot(item) {
  return JSON.stringify({
    i: Number(item?.i),
    scheduledAt: item?.scheduledAt ?? null,
    topic: item?.topic ?? "",
    draft: item?.draft ?? "",
    status: item?.status ?? "",
    postId: Number(item?.postId) || null,
    aiReady: item?.aiReady ?? null,
    qualityBlocked: item?.qualityBlocked ?? null,
    reviewRequired: item?.reviewRequired ?? null,
    reviewState: item?.reviewState ?? null,
    invented: item?.invented ?? null,
    quality: item?.quality ?? null,
  });
}

export function autopilotItemOperationKey(projectIdValue, planIdValue, itemIndexValue) {
  const projectId = positiveInteger(projectIdValue, "project id");
  const planId = positiveInteger(planIdValue, "plan id");
  const index = itemIndex(itemIndexValue);
  return `autopilot:${projectId}:${planId}:item:${index}`;
}

export function resolvedAutopilotPlanStatus(items) {
  return cloneItems(items).some(
    (item) => item.status === "pending" || item.status === "expired",
  )
    ? "pending"
    : "approved";
}

function requestFingerprint({ projectId, userId, channelId, text, scheduledAt }) {
  return createHash("sha256")
    .update(JSON.stringify([projectId, userId, channelId, text, scheduledAt]))
    .digest("hex");
}

export async function reclaimStaleAutopilotApprovals(
  db,
  {
    projectId: projectIdValue = null,
    userId: userIdValue = null,
    channelId: channelIdValue = null,
    leaseSeconds: leaseSecondsValue = AUTOPILOT_APPROVAL_LEASE_SECONDS,
  } = {},
) {
  const projectId = projectIdValue == null ? null : positiveInteger(projectIdValue, "project id");
  const userId = userIdValue == null ? null : positiveInteger(userIdValue, "user id");
  const channelId = channelIdValue == null ? null : positiveInteger(channelIdValue, "channel id");
  const leaseSeconds = Math.max(30, Math.min(3_600, Number(leaseSecondsValue) || 0));
  const result = await db.query(
    `with stale as materialized (
       select p.id, p.project_id, p.user_id, p.channel_id, p.approval_operation_id,
              c.title, c.handle,
              case when exists (
                select 1 from jsonb_array_elements(p.items) item
                 where item->>'status' in ('pending', 'expired')
              ) then 'pending' else 'approved' end as next_status,
              (select count(*)::int
                 from autopilot_schedule_outbox o
                where o.plan_id = p.id and o.project_id = p.project_id
                  and o.operation_id = p.approval_operation_id
                  and o.status <> 'cancelled') as scheduled_count,
              (select count(*)::int
                 from jsonb_array_elements(p.items) item
                where item->>'status' = 'pending' and not (item ? 'postId')) as remaining_count
         from autopilot_plan p
         left join channels c on c.id = p.channel_id and c.project_id = p.project_id
        where p.status = 'approving'
          and coalesce(p.approval_heartbeat_at, p.approval_started_at, p.created_at)
              < now() - make_interval(secs => $1::int)
          and ($2::bigint is null or p.project_id = $2)
          and ($3::bigint is null or p.user_id = $3)
          and ($4::bigint is null or p.channel_id = $4)
        for update of p skip locked
     ), reclaimed as (
       update autopilot_plan p
          set status = s.next_status,
              approval_operation_id = null,
              approval_started_at = null,
              approval_heartbeat_at = null,
              revision = revision + 1
         from stale s
        where p.id = s.id
       returning p.id, s.project_id, s.user_id, s.channel_id, s.approval_operation_id,
                 s.title, s.handle, s.next_status, s.scheduled_count, s.remaining_count
     ), finished as (
       update autopilot_approval_operations op
          set status = case when r.scheduled_count > 0 then 'partial' else 'failed' end,
              result = jsonb_build_object(
                'ok', false,
                'error', 'approval_interrupted',
                'scheduled', r.scheduled_count,
                'blocked', 0,
                'expired', 0,
                'partial', r.scheduled_count > 0,
                'retryable', true,
                'planId', r.id,
                'channel', jsonb_build_object(
                  'id', r.channel_id, 'title', r.title, 'handle', r.handle
                ),
                'remaining', jsonb_build_object('pending', r.remaining_count),
                'message', 'Предыдущее подтверждение прервалось. Сохранённые посты не продублируются; открой план и повтори оставшиеся.'
              ),
              http_status = 503,
              completed_at = now()
         from reclaimed r
        where op.id = r.approval_operation_id and op.project_id = r.project_id
          and op.status = 'processing' and op.result is null
       returning op.id
     )
     select id, project_id, user_id, channel_id, next_status, scheduled_count, remaining_count
       from reclaimed
      order by id`,
    [leaseSeconds, projectId, userId, channelId],
  );
  return result.rows ?? [];
}

export async function claimAutopilotPlan(
  db,
  {
    planId: planIdValue,
    projectId: projectIdValue,
    userId: userIdValue,
    channelId: channelIdValue,
    operationId: operationIdValue,
    allowedStatuses = ["pending"],
    expectedRevision: expectedRevisionValue = null,
  },
) {
  const planId = positiveInteger(planIdValue, "plan id");
  const projectId = positiveInteger(projectIdValue, "project id");
  const userId = positiveInteger(userIdValue, "user id");
  const channelId = positiveInteger(channelIdValue, "channel id");
  const operationId = positiveInteger(operationIdValue, "operation id");
  const expectedRevision = expectedRevisionValue == null
    ? null
    : positiveInteger(expectedRevisionValue, "plan revision");
  const statuses = [...new Set(allowedStatuses)].filter((status) => planStatuses.has(status));
  if (!statuses.length) throw new TypeError("invalid plan statuses");
  const result = await db.query(
    `update autopilot_plan
        set status = 'approving',
            approval_operation_id = $5,
            approval_started_at = now(),
            approval_heartbeat_at = now(),
            revision = revision + 1
      where id = $1 and project_id = $2 and channel_id = $4
        and status = any($6::text[])
        and ($7::bigint is null or revision = $7)
        and exists (
          select 1 from channels c
           where c.id = $4 and c.project_id = $2
             and c.network = 'tg' and c.is_active = true
        )
        and exists (
          select 1 from autopilot_approval_operations op
           where op.id = $5 and op.project_id = $2 and op.user_id = $3
             and op.channel_id = $4 and op.plan_id = $1
             and op.status = 'processing'
        )
      returning id, items, edited, channel_id, revision`,
    [planId, projectId, userId, channelId, operationId, statuses, expectedRevision],
  );
  return result.rows?.[0] ?? null;
}

async function markDispatch(pool, outboxId, projectId, success, error = null) {
  try {
    await pool.query(
      `update autopilot_schedule_outbox
          set status = case when $3 then 'enqueued' else 'pending' end,
              attempts = attempts + 1,
              last_error = case when $3 then null else $4 end,
              enqueued_at = case when $3 then coalesce(enqueued_at, now()) else enqueued_at end,
              updated_at = now()
        where id = $1 and project_id = $2`,
      [outboxId, projectId, success, error == null ? null : String(error).slice(0, 500)],
    );
    return true;
  } catch {
    // A missing acknowledgement deliberately leaves the row pending. Re-dispatch uses the
    // same BullMQ job id and is therefore safe after an ambiguous DB failure.
    return false;
  }
}

async function dispatchCheckpoint(pool, enqueue, checkpoint) {
  if (checkpoint.post_status !== "scheduled") {
    const marked = await markDispatch(pool, checkpoint.id, checkpoint.project_id, true);
    return { queuePending: !marked, queueError: null };
  }
  try {
    await enqueue(
      Number(checkpoint.project_id),
      Number(checkpoint.post_id),
      new Date(checkpoint.scheduled_at).toISOString(),
      Number(checkpoint.schedule_revision || 1),
    );
    const marked = await markDispatch(pool, checkpoint.id, checkpoint.project_id, true);
    return { queuePending: !marked, queueError: null };
  } catch (error) {
    await markDispatch(pool, checkpoint.id, checkpoint.project_id, false, error?.message || error);
    return { queuePending: true, queueError: error };
  }
}

/**
 * Atomically persists one post, its durable outbox row and the item checkpoint. Queue
 * delivery happens only after commit and may be repeated safely with `post-{postId}`.
 */
export async function scheduleAutopilotItem({
  pool,
  enqueue,
  planId: planIdValue,
  projectId: projectIdValue,
  userId: userIdValue,
  channelId: channelIdValue,
  operationId: operationIdValue,
  index: indexValue,
  approvedItem = null,
  nowMs = Date.now(),
}) {
  const planId = positiveInteger(planIdValue, "plan id");
  const projectId = positiveInteger(projectIdValue, "project id");
  const userId = positiveInteger(userIdValue, "user id");
  const channelId = positiveInteger(channelIdValue, "channel id");
  const operationId = positiveInteger(operationIdValue, "operation id");
  const index = itemIndex(indexValue);
  if (typeof enqueue !== "function") throw new TypeError("enqueue is required");

  const tx = await pool.connect();
  let checkpoint;
  let items;
  try {
    await tx.query("begin");
    const plan = (
      await tx.query(
        `select items
           from autopilot_plan
          where id = $1 and project_id = $2 and channel_id = $4
            and status = 'approving' and approval_operation_id = $5
            and exists (
              select 1 from channels c
               where c.id = $4 and c.project_id = $2
                 and c.network = 'tg' and c.is_active = true
            )
            and exists (
              select 1 from autopilot_approval_operations op
               where op.id = $5 and op.project_id = $2 and op.user_id = $3
                 and op.channel_id = $4 and op.plan_id = $1
                 and op.status = 'processing'
            )
          for update`,
        [planId, projectId, userId, channelId, operationId],
      )
    ).rows?.[0];
    if (!plan) throw new AutopilotApprovalLeaseLostError();

    items = cloneItems(plan.items);
    const target = items.find((item) => Number(item.i) === index);
    if (!target) throw new AutopilotScheduleBlockedError([{ code: "no_item", message: "Пост не найден в плане." }]);
    if (approvedItem != null && approvalSnapshot(target) !== approvalSnapshot(approvedItem)) {
      throw new AutopilotApprovalLeaseLostError();
    }

    checkpoint = (
      await tx.query(
        `select o.id, o.project_id, o.post_id, o.scheduled_at, o.status, p.status as post_status
           from autopilot_schedule_outbox o
           join posts p on p.id = o.post_id and p.project_id = o.project_id
          where o.plan_id = $1 and o.project_id = $2 and o.item_index = $3
          for update of o`,
        [planId, projectId, index],
      )
    ).rows?.[0];

    if (!checkpoint && Number.isSafeInteger(Number(target.postId)) && Number(target.postId) > 0) {
      checkpoint = (
        await tx.query(
          `insert into autopilot_schedule_outbox
             (plan_id, item_index, project_id, user_id, channel_id, operation_id, post_id, scheduled_at)
           select $1, $2, $3, $4, $5, $6, p.id, p.scheduled_at
             from posts p
            where p.id = $7 and p.project_id = $3 and p.channel_id = $5
           on conflict (plan_id, item_index) do update
             set operation_id = excluded.operation_id, updated_at = now()
           returning id, project_id, post_id, scheduled_at, status`,
          [planId, index, projectId, userId, channelId, operationId, Number(target.postId)],
        )
      ).rows?.[0];
      if (!checkpoint) throw new Error("autopilot checkpoint post missing");
    }

    if (!checkpoint) {
      const evaluationTarget = approvedItem ?? target;
      const evaluation = evaluateAutopilotItem(evaluationTarget, nowMs);
      if (!evaluation.eligible || !evaluation.scheduledAt) {
        throw new AutopilotScheduleBlockedError(evaluation.blockers);
      }
      const text = sanitizeAutopilotPublicText(target.draft);
      if (!text) {
        throw new AutopilotScheduleBlockedError([{ code: "empty_draft", message: "Черновик пуст." }]);
      }
      target.draft = text;
      if (approvedItem?.humanAttestation) {
        target.humanAttestation = approvedItem.humanAttestation;
        target.qualityOrigin = approvedItem.qualityOrigin;
      }
      const key = autopilotItemOperationKey(projectId, planId, index);
      const fingerprint = requestFingerprint({
        projectId,
        userId,
        channelId,
        text,
        scheduledAt: evaluation.scheduledAt,
      });
      const inserted = await tx.query(
        `insert into posts
           (project_id, user_id, channel_id, text, scheduled_at, status, idempotency_key,
            request_fingerprint, publication_origin)
         values ($1, $2, $3, $4, $5, 'scheduled', $6, $7, 'autopilot')
         on conflict do nothing
         returning id, scheduled_at, status, request_fingerprint, schedule_revision`,
        [projectId, userId, channelId, text, evaluation.scheduledAt, key, fingerprint],
      );
      let post = inserted.rows?.[0];
      if (!post) {
        post = (
          await tx.query(
            `select id, scheduled_at, status, request_fingerprint, schedule_revision
               from posts
              where project_id = $1 and idempotency_key = $2
              for update`,
            [projectId, key],
          )
        ).rows?.[0];
      }
      if (!post) throw new Error("autopilot deterministic post conflict");
      if (post.request_fingerprint !== fingerprint) {
        throw new Error("autopilot deterministic post fingerprint conflict");
      }

      checkpoint = (
        await tx.query(
          `insert into autopilot_schedule_outbox
             (plan_id, item_index, project_id, user_id, channel_id, operation_id, post_id, scheduled_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (plan_id, item_index) do update
             set operation_id = excluded.operation_id, updated_at = now()
           returning id, project_id, post_id, scheduled_at, status`,
          [planId, index, projectId, userId, channelId, operationId, Number(post.id), post.scheduled_at],
        )
      ).rows?.[0];
    }

    if (!checkpoint) throw new Error("autopilot checkpoint missing");
    const checkpointPost = (
      await tx.query(
        `select status, schedule_revision
           from posts
          where id = $1 and project_id = $2 and channel_id = $3
          for key share`,
        [Number(checkpoint.post_id), projectId, channelId],
      )
    ).rows?.[0];
    if (!checkpointPost) throw new Error("autopilot checkpoint post missing");
    checkpoint.post_status = checkpointPost.status;
    checkpoint.schedule_revision = Number(checkpointPost.schedule_revision || 1);
    target.postId = Number(checkpoint.post_id);
    target.status = "approved";
    if (target.monthlyCampaignItemId != null) {
      const monthlyItemId = positiveInteger(target.monthlyCampaignItemId, "monthly campaign item id");
      const monthlyItemVersion = positiveInteger(
        target.monthlyCampaignItemVersion,
        "monthly campaign item version",
      );
      const linked = await tx.query(
        `update monthly_campaign_items
            set post_id = $4,
                draft_id = coalesce($5, draft_id),
                updated_at = now()
          where id = $1 and project_id = $2
            and weekly_autopilot_plan_id = $3
            and weekly_autopilot_item_index = $6
            and content_version = $7`,
        [
          monthlyItemId,
          projectId,
          planId,
          Number(checkpoint.post_id),
          Number(target.draftId) || null,
          index,
          monthlyItemVersion,
        ],
      );
      if (linked.rowCount !== 1) throw new Error("monthly campaign lineage changed before scheduling");
    }
    const saved = await tx.query(
      `update autopilot_plan
          set items = $6::jsonb, approval_heartbeat_at = now(), revision = revision + 1
        where id = $1 and project_id = $2 and channel_id = $4
          and status = 'approving' and approval_operation_id = $5
        returning id`,
      [planId, projectId, userId, channelId, operationId, JSON.stringify(items)],
    );
    if (saved.rowCount !== 1) throw new AutopilotApprovalLeaseLostError();
    await tx.query("commit");
  } catch (error) {
    await tx.query("rollback").catch(() => {});
    throw error;
  } finally {
    tx.release();
  }

  const dispatched = await dispatchCheckpoint(pool, enqueue, checkpoint);
  return {
    postId: Number(checkpoint.post_id),
    scheduledAt: new Date(checkpoint.scheduled_at).toISOString(),
    items,
    replayed: checkpoint.status === "enqueued",
    ...dispatched,
  };
}

export async function finalizeAutopilotApproval({
  pool,
  planId: planIdValue,
  projectId: projectIdValue,
  userId: userIdValue,
  channelId: channelIdValue,
  operationId: operationIdValue,
  items,
  planStatus = resolvedAutopilotPlanStatus(items),
  operationStatus,
  result,
  httpStatus,
  streakEligible = null,
  edited = false,
}) {
  const planId = positiveInteger(planIdValue, "plan id");
  const projectId = positiveInteger(projectIdValue, "project id");
  const userId = positiveInteger(userIdValue, "user id");
  const channelId = positiveInteger(channelIdValue, "channel id");
  const operationId = positiveInteger(operationIdValue, "operation id");
  if (!planStatuses.has(planStatus)) throw new TypeError("invalid final plan status");
  if (!operationStatuses.has(operationStatus)) throw new TypeError("invalid operation status");
  const tx = await pool.connect();
  try {
    await tx.query("begin");
    const saved = await tx.query(
      `update autopilot_plan
          set items = $6::jsonb,
              status = $7,
              approval_operation_id = null,
              approval_started_at = null,
              approval_heartbeat_at = null,
              revision = revision + 1
        where id = $1 and project_id = $2 and channel_id = $4
          and status = 'approving' and approval_operation_id = $5
          and exists (
            select 1 from autopilot_approval_operations op
             where op.id = $5 and op.project_id = $2 and op.user_id = $3
               and op.channel_id = $4 and op.plan_id = $1
               and op.status = 'processing'
          )
        returning id`,
      [planId, projectId, userId, channelId, operationId, JSON.stringify(items), planStatus],
    );
    if (saved.rowCount !== 1) throw new AutopilotApprovalLeaseLostError();

    if (streakEligible != null) {
      await tx.query(
        `update autopilot_settings
            set approvals_streak = case when $3 and not $4 then approvals_streak + 1 else 0 end,
                updated_at = now()
          where project_id = $1 and channel_id = $2`,
        [projectId, channelId, streakEligible === true, edited === true],
      );
    }

    const finished = await tx.query(
      `update autopilot_approval_operations
          set status = $4, result = $5::jsonb, http_status = $6, completed_at = now()
        where id = $1 and project_id = $2 and user_id = $3
          and status = 'processing' and result is null
        returning id`,
      [operationId, projectId, userId, operationStatus, JSON.stringify(result), httpStatus],
    );
    if (finished.rowCount !== 1) throw new AutopilotApprovalLeaseLostError();
    await tx.query("commit");
    return true;
  } catch (error) {
    await tx.query("rollback").catch(() => {});
    throw error;
  } finally {
    tx.release();
  }
}

export async function abortAutopilotApproval({
  pool,
  planId: planIdValue,
  projectId: projectIdValue,
  userId: userIdValue,
  channelId: channelIdValue,
  operationId: operationIdValue,
  result,
  httpStatus = 500,
}) {
  const planId = positiveInteger(planIdValue, "plan id");
  const projectId = positiveInteger(projectIdValue, "project id");
  const userId = positiveInteger(userIdValue, "user id");
  const channelId = positiveInteger(channelIdValue, "channel id");
  const operationId = positiveInteger(operationIdValue, "operation id");
  const tx = await pool.connect();
  try {
    await tx.query("begin");
    const plan = (
      await tx.query(
        `select items from autopilot_plan
          where id = $1 and project_id = $2 and channel_id = $4
            and status = 'approving' and approval_operation_id = $5
            and exists (
              select 1 from autopilot_approval_operations op
               where op.id = $5 and op.project_id = $2 and op.user_id = $3
                 and op.channel_id = $4 and op.plan_id = $1
                 and op.status = 'processing'
            )
          for update`,
        [planId, projectId, userId, channelId, operationId],
      )
    ).rows?.[0];
    if (!plan) {
      await tx.query("rollback");
      return false;
    }
    const durableScheduled = Number((
      await tx.query(
        `select count(*)::int as count
           from autopilot_schedule_outbox
          where plan_id = $1 and project_id = $2 and channel_id = $3
            and operation_id = $4
            and status <> 'cancelled'`,
        [planId, projectId, channelId, operationId],
      )
    ).rows?.[0]?.count ?? 0);
    const reportedScheduled = Number.isFinite(Number(result?.scheduled))
      ? Math.max(0, Number(result.scheduled))
      : 0;
    const scheduled = Math.max(reportedScheduled, durableScheduled);
    const durableResult = result && typeof result === "object"
      ? { ...result, scheduled, partial: scheduled > 0 }
      : { ok: false, error: "server", retryable: true, scheduled, partial: scheduled > 0 };
    const status = resolvedAutopilotPlanStatus(plan.items);
    await tx.query(
      `update autopilot_plan
          set status = $6,
              approval_operation_id = null,
              approval_started_at = null,
              approval_heartbeat_at = null,
              revision = revision + 1
        where id = $1 and project_id = $2 and channel_id = $4 and approval_operation_id = $5`,
      [planId, projectId, userId, channelId, operationId, status],
    );
    const finished = await tx.query(
      `update autopilot_approval_operations
          set status = $4, result = $5::jsonb, http_status = $6, completed_at = now()
        where id = $1 and project_id = $2 and user_id = $3
          and status = 'processing' and result is null`,
      [
        operationId,
        projectId,
        userId,
        scheduled > 0 ? "partial" : "failed",
        JSON.stringify(durableResult),
        httpStatus,
      ],
    );
    if (finished.rowCount !== 1) throw new AutopilotApprovalLeaseLostError();
    await tx.query("commit");
    return true;
  } catch (error) {
    await tx.query("rollback").catch(() => {});
    throw error;
  } finally {
    tx.release();
  }
}

export async function reconcileAutopilotScheduleOutbox({ pool, enqueue, limit = 250 }) {
  const boundedLimit = Math.max(1, Math.min(1_000, Number(limit) || 250));
  const rows = (
    await pool.query(
      `select o.id, o.project_id, o.post_id, o.scheduled_at, o.status, p.status as post_status,
              p.schedule_revision
         from autopilot_schedule_outbox o
         join posts p on p.id = o.post_id and p.project_id = o.project_id
        where o.status = 'pending' or p.status = 'scheduled'
        order by o.updated_at, o.id
        limit $1`,
      [boundedLimit],
    )
  ).rows ?? [];
  let enqueued = 0;
  let pending = 0;
  for (const checkpoint of rows) {
    const result = await dispatchCheckpoint(pool, enqueue, checkpoint);
    if (result.queuePending) pending += 1;
    else enqueued += 1;
  }
  return { scanned: rows.length, enqueued, pending };
}
