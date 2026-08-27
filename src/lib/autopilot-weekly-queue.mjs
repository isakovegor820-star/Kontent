import {
  AUTOPILOT_JOB_ATTEMPTS,
  AUTOPILOT_JOB_BACKOFF_MS,
  normalizeAutopilotEngine,
  normalizePlanningWeeks,
  plannedPostCountForWeeks,
} from "./autopilot-config.mjs";
import { autopilotCandidateCount } from "./autopilot-candidate-selection.mjs";
import { normalizeAutopilotQuickSettings } from "./autopilot-style.mjs";
import { randomUUID } from "node:crypto";

export const AUTOPILOT_CONTINUATION_JOB = "autopilot-continue";
export const AUTOPILOT_AUTO_RECOVERY_STRATEGIES = Object.freeze([
  "deterministic_format",
  "provider_retry",
  "rewrite",
]);

const AUTO_RECOVERY_STRATEGIES = new Set(AUTOPILOT_AUTO_RECOVERY_STRATEGIES);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isAutopilotAutoRecoveryStrategy(value) {
  return AUTO_RECOVERY_STRATEGIES.has(String(value || ""));
}

export function autopilotAutoRecoveryDelayMs(attemptNumber) {
  const attempt = Math.max(1, Math.round(Number(attemptNumber) || 1));
  return Math.min(30 * 60_000, 30_000 * (2 ** Math.min(6, attempt - 1)));
}

export function autopilotAutoRecoveryReport(
  report,
  {
    enabled = true,
    recoveryJobId = randomUUID(),
    attemptNumber = 1,
    nowMs = Date.now(),
    delayMs = null,
    recoveryState = null,
  } = {},
) {
  if (!UUID.test(String(recoveryJobId))) throw new Error("bad_autopilot_recovery_job_id");
  const attempt = Math.max(1, Math.round(Number(attemptNumber) || 1));
  const scheduledDelayMs = enabled
    ? delayMs != null && Number.isFinite(Number(delayMs))
      ? Math.max(0, Number(delayMs))
      : autopilotAutoRecoveryDelayMs(attempt)
    : null;
  const nextRetryAt = scheduledDelayMs == null
    ? null
    : new Date(nowMs + scheduledDelayMs).toISOString();
  return {
    ...(report && typeof report === "object" ? report : {}),
    recoveryState: enabled
      ? String(recoveryState || "auto_retry_scheduled")
      : "paused",
    attemptNumber: attempt,
    nextRetryAt,
    autoRecovery: {
      jobId: String(recoveryJobId).toLowerCase(),
      attemptNumber: attempt,
      nextRetryAt,
    },
  };
}

function continuationJobOptions(planId, recoveryJobId, delay = 0) {
  return {
    jobId: `autopilot-continue-${planId}-${recoveryJobId}`,
    removeOnComplete: true,
    removeOnFail: true,
    attempts: AUTOPILOT_JOB_ATTEMPTS,
    backoff: { type: "fixed", delay: AUTOPILOT_JOB_BACKOFF_MS },
    ...(delay > 0 ? { delay } : {}),
  };
}

function recoveryDescriptor(row, { force = false, nowMs = Date.now() } = {}) {
  const report = row?.build_report && typeof row.build_report === "object" ? row.build_report : {};
  const recovery = report.autoRecovery && typeof report.autoRecovery === "object"
    ? report.autoRecovery
    : {};
  const recoveryJobId = String(recovery.jobId || "").toLowerCase();
  if (
    row?.enabled !== true ||
    !isAutopilotAutoRecoveryStrategy(row?.repair_strategy || report.primaryFix) ||
    !UUID.test(recoveryJobId)
  ) return null;
  const retryAtMs = Date.parse(String(recovery.nextRetryAt || report.nextRetryAt || ""));
  const delay = force || !Number.isFinite(retryAtMs) ? 0 : Math.max(0, retryAtMs - nowMs);
  return { recoveryJobId, delay };
}

async function ensurePartialRecoveryState(pool, row, { force = false, nowMs = Date.now() } = {}) {
  const existing = recoveryDescriptor(row, { force, nowMs });
  if (existing && (!force || row?.status !== "partial")) {
    return { ...row, descriptor: existing };
  }
  if (
    row?.status !== "partial" || row?.enabled !== true ||
    !isAutopilotAutoRecoveryStrategy(row?.repair_strategy || row?.build_report?.primaryFix)
  ) return null;
  const buildReport = autopilotAutoRecoveryReport(row.build_report, {
    enabled: true,
    ...(existing ? { recoveryJobId: existing.recoveryJobId } : {}),
    attemptNumber: Math.max(
      1,
      Number(row?.build_report?.autoRecovery?.attemptNumber || row?.repair_attempt || 0) +
        (existing ? 0 : 1),
    ),
    nowMs,
    ...(force ? { delayMs: 0 } : {}),
  });
  const updated = (
    await pool.query(
      `update autopilot_plan
          set build_report = $4::jsonb, repair_strategy = $5,
              build_activity_at = now(), revision = revision + 1
        where id = $1 and project_id = $2 and channel_id = $3 and status = 'partial'
        returning id, project_id, user_id, channel_id, status, build_report,
                  repair_strategy, repair_attempt`,
      [
        row.id,
        row.project_id,
        row.channel_id,
        JSON.stringify(buildReport),
        row.repair_strategy || buildReport.primaryFix,
      ],
    )
  ).rows[0];
  if (!updated) return null;
  const prepared = { ...row, ...updated, enabled: true };
  return { ...prepared, descriptor: recoveryDescriptor(prepared, { force, nowMs }) };
}

export async function dispatchAutopilotContinuation({
  queue,
  row,
  force = false,
  nowMs = Date.now(),
}) {
  if (!queue?.add) throw new Error("autopilot_queue_missing");
  const descriptor = recoveryDescriptor(row, { force, nowMs });
  if (!descriptor) return { status: "skipped", reason: "not_recoverable" };
  const projectId = positiveInteger(row.project_id, "project_id");
  const userId = positiveInteger(row.user_id, "user_id");
  const channelId = positiveInteger(row.channel_id, "channel_id");
  const planId = positiveInteger(row.id, "plan_id");
  await queue.add(
    AUTOPILOT_CONTINUATION_JOB,
    {
      projectId,
      userId,
      channelId,
      planId,
      recoveryJobId: descriptor.recoveryJobId,
    },
    continuationJobOptions(planId, descriptor.recoveryJobId, descriptor.delay),
  );
  return {
    status: "queued",
    planId,
    recoveryJobId: descriptor.recoveryJobId,
    delay: descriptor.delay,
  };
}

const positiveInteger = (value, name) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`bad_${name}`);
  return number;
};

function autopilotPlanJobOptions(planId) {
  return {
    jobId: `autopilot-plan-${planId}`,
    removeOnComplete: true,
    attempts: AUTOPILOT_JOB_ATTEMPTS,
    backoff: { type: "fixed", delay: AUTOPILOT_JOB_BACKOFF_MS },
  };
}

export async function dispatchAutopilotPlanJob({
  queue,
  projectId: rawProjectId,
  userId: rawUserId,
  channelId: rawChannelId,
  planId: rawPlanId,
}) {
  const projectId = positiveInteger(rawProjectId, "project_id");
  const userId = positiveInteger(rawUserId, "user_id");
  const channelId = positiveInteger(rawChannelId, "channel_id");
  const planId = positiveInteger(rawPlanId, "plan_id");
  if (!queue?.add) throw new Error("autopilot_queue_missing");
  await queue.add(
    "autopilot-plan",
    { projectId, userId, channelId, planId },
    autopilotPlanJobOptions(planId),
  );
  return { jobId: `autopilot-plan-${planId}` };
}

/**
 * PostgreSQL is authoritative for build ownership. Replaying the deterministic BullMQ id
 * is safe when the job already exists and closes the crash window between DB commit and
 * queue.add for both manual and weekly builds.
 */
export async function reconcileBuildingAutopilotPlans({ pool, queue, limit = 250 }) {
  if (!pool?.query || !queue?.add) throw new Error("autopilot_reconcile_dependencies_missing");
  const boundedLimit = Math.max(1, Math.min(1_000, Math.trunc(Number(limit) || 250)));
  const rows = (
    await pool.query(
      `select plan.id, plan.project_id, plan.user_id, plan.channel_id, plan.status,
              plan.build_report, plan.repair_strategy, plan.repair_attempt,
              settings.enabled
         from autopilot_plan plan
         join channels channel
           on channel.id = plan.channel_id and channel.project_id = plan.project_id
          and channel.network = 'tg' and channel.is_active = true
         join project_members member
           on member.project_id = plan.project_id and member.user_id = plan.user_id
          and member.status = 'active' and member.role in ('owner','author','approver')
         join autopilot_settings settings
           on settings.project_id = plan.project_id and settings.channel_id = plan.channel_id
        where (
             plan.status = 'building'
           or (
             plan.status = 'partial' and settings.enabled = true
             and plan.repair_strategy in ('deterministic_format', 'provider_retry', 'rewrite')
           )
        )
        order by plan.build_activity_at nulls first, plan.created_at, plan.id
        limit $1`,
      [boundedLimit],
    )
  ).rows;
  const result = { scanned: rows.length, enqueued: 0, pending: 0 };
  for (const row of rows) {
    try {
      if (row.status === "partial" || row.build_report?.autoRecovery?.jobId) {
        const prepared = row.status === "partial"
          ? await ensurePartialRecoveryState(pool, row)
          : { ...row, descriptor: recoveryDescriptor(row, { force: true }) };
        if (!prepared?.descriptor) continue;
        await dispatchAutopilotContinuation({ queue, row: prepared });
      } else {
        await dispatchAutopilotPlanJob({
          queue,
          projectId: row.project_id,
          userId: row.user_id,
          channelId: row.channel_id,
          planId: row.id,
        });
      }
      result.enqueued++;
    } catch {
      // Keep the durable building row authoritative. The next reconciliation tick retries
      // the same deterministic job id without losing or duplicating the plan.
      result.pending++;
    }
  }
  return result;
}

export async function resumeAutopilotPartialPlan({
  pool,
  queue,
  projectId: rawProjectId,
  userId: rawUserId,
  channelId: rawChannelId,
  nowMs = Date.now(),
}) {
  const projectId = positiveInteger(rawProjectId, "project_id");
  positiveInteger(rawUserId, "user_id");
  const channelId = positiveInteger(rawChannelId, "channel_id");
  const row = (
    await pool.query(
      `select plan.id, plan.project_id, plan.user_id, plan.channel_id, plan.status,
              plan.build_report, plan.repair_strategy, plan.repair_attempt,
              settings.enabled
         from autopilot_plan plan
         join autopilot_settings settings
           on settings.project_id = plan.project_id and settings.channel_id = plan.channel_id
        where plan.project_id = $1 and plan.channel_id = $2
          and plan.status = 'partial' and settings.enabled = true
          and plan.repair_strategy in ('deterministic_format', 'provider_retry', 'rewrite')
        order by plan.created_at desc, plan.id desc limit 1`,
      [projectId, channelId],
    )
  ).rows[0];
  if (!row) return { status: "skipped", reason: "no_partial_plan" };
  const prepared = await ensurePartialRecoveryState(pool, row, { force: true, nowMs });
  if (!prepared) return { status: "skipped", reason: "not_recoverable" };
  return dispatchAutopilotContinuation({ queue, row: prepared, force: true, nowMs });
}

/**
 * Creates the same durable building placeholder used by the manual endpoint and dispatches
 * it to the dedicated Autopilot queue. The settings row is the per-channel mutex shared with
 * manual generation, so a Sunday tick and a button click cannot create competing plans.
 */
export async function enqueueWeeklyAutopilotPlan({
  pool,
  queue,
  projectId: rawProjectId,
  userId: rawUserId,
  channelId: rawChannelId,
  nowMs = Date.now(),
}) {
  const projectId = positiveInteger(rawProjectId, "project_id");
  const userId = positiveInteger(rawUserId, "user_id");
  const channelId = positiveInteger(rawChannelId, "channel_id");
  if (!pool?.connect || !pool?.query || !queue?.add) throw new Error("weekly_queue_dependencies_missing");

  const tx = await pool.connect();
  let planId = null;
  let publicationTargetCount = 0;
  let candidateCount = 0;
  let recoveredBuilding = false;
  try {
    await tx.query("begin");
    const target = (
      await tx.query(
        `select settings.user_id, settings.post_frequency, settings.generation_engine,
                settings.planning_months, settings.planning_weeks, settings.quick_settings
           from autopilot_settings settings
           join channels channel
             on channel.id = settings.channel_id and channel.project_id = settings.project_id
            and channel.network = 'tg' and channel.is_active = true
           join project_members member
             on member.project_id = settings.project_id and member.user_id = settings.user_id
            and member.status = 'active' and member.role in ('owner','author','approver')
          where settings.project_id = $1 and settings.user_id = $2
            and settings.channel_id = $3 and settings.enabled = true
          for update of settings`,
        [projectId, userId, channelId],
      )
    ).rows[0];
    if (!target) {
      await tx.query("rollback");
      return { status: "skipped", reason: "disabled_or_unavailable" };
    }

    const plans = (
      await tx.query(
      `select id, project_id, user_id, channel_id, status, items, build_report,
              repair_strategy, repair_attempt,
              expected_post_count, publication_target_count, candidate_count
           from autopilot_plan
          where project_id = $1 and channel_id = $2
            and status in ('building', 'partial', 'pending', 'approved', 'approving')
          order by created_at desc, id desc`,
        [projectId, channelId],
      )
    ).rows;
    // Only the newest durable plan owns this channel. Looking for any matching status could
    // revive an old partial underneath a newer approved plan and later replace its calendar.
    const currentPlan = plans[0] || null;
    const buildingPlan = currentPlan?.status === "building" ? currentPlan : null;
    if (buildingPlan) {
      planId = positiveInteger(buildingPlan.id, "plan_id");
      publicationTargetCount = Math.max(
        0,
        Number(buildingPlan.publication_target_count || buildingPlan.expected_post_count || 0),
      );
      candidateCount = Math.max(
        0,
        Number(buildingPlan.candidate_count || buildingPlan.expected_post_count || 0),
      );
      recoveredBuilding = true;
      await tx.query("commit");
    }

    const partialPlan = currentPlan?.status === "partial" ? currentPlan : null;
    if (!recoveredBuilding && partialPlan) {
      await tx.query("commit");
      const prepared = await ensurePartialRecoveryState(pool, {
        ...partialPlan,
        project_id: projectId,
        user_id: userId,
        channel_id: channelId,
        enabled: true,
      }, { force: true, nowMs });
      if (!prepared) {
        return { status: "skipped", reason: "partial_requires_attention", planId: Number(partialPlan.id) };
      }
      const resumed = await dispatchAutopilotContinuation({
        queue,
        row: prepared,
        force: true,
        nowMs,
      }).catch(() => null);
      return resumed
        ? {
            status: "queued",
            planId: Number(partialPlan.id),
            publicationTargetCount: Math.max(
              0,
              Number(partialPlan.publication_target_count || partialPlan.expected_post_count || 0),
            ),
            candidateCount: Math.max(
              0,
              Number(partialPlan.candidate_count || partialPlan.expected_post_count || 0),
            ),
            recovered: true,
          }
        : { status: "pending_reconciliation", reason: "queue_unavailable", planId: Number(partialPlan.id) };
    }

    if (!recoveredBuilding) {
      const activePlan = ["pending", "approved", "approving"].includes(currentPlan?.status)
        ? currentPlan
        : null;
      const coverageUntil = (Array.isArray(activePlan?.items) ? activePlan.items : [])
        .map((item) => Date.parse(String(item?.scheduledAt || "")))
        .filter(Number.isFinite)
        .reduce((latest, value) => Math.max(latest, value), 0);
      if (coverageUntil > nowMs + 7 * 86_400_000) {
        await tx.query("rollback");
        return { status: "skipped", reason: "coverage_sufficient" };
      }

      const planningWeeks = normalizePlanningWeeks(
        target.planning_weeks ?? Number(target.planning_months || 1) * 4,
      );
      const planningMonths = Math.max(1, Math.min(3, Math.ceil(planningWeeks / 4)));
      const generationPostFrequency = Math.max(1, Math.min(7, Math.round(Number(target.post_frequency) || 5)));
      const generationEngine = normalizeAutopilotEngine(target.generation_engine);
      const quickSettings = normalizeAutopilotQuickSettings(target.quick_settings);
      publicationTargetCount = plannedPostCountForWeeks(generationPostFrequency, planningWeeks);
      candidateCount = autopilotCandidateCount(publicationTargetCount);

      const inserted = await tx.query(
        `insert into autopilot_plan
            (project_id, user_id, channel_id, week_start, status, generation_engine,
             generation_post_frequency, expected_post_count, publication_target_count,
             candidate_count, planning_months, planning_weeks, quick_settings, build_activity_at)
         values ($1, $2, $3, current_date, 'building', $4, $5, $6, $6, $7,
                 $8, $9, $10::jsonb, now())
         returning id`,
        [
          projectId,
          userId,
          channelId,
          generationEngine,
          generationPostFrequency,
          publicationTargetCount,
          candidateCount,
          planningMonths,
          planningWeeks,
          JSON.stringify(quickSettings),
        ],
      );
      planId = positiveInteger(inserted.rows[0]?.id, "plan_id");
      await tx.query("commit");
    }
  } catch (error) {
    await tx.query("rollback").catch(() => {});
    throw error;
  } finally {
    tx.release();
  }

  try {
    await dispatchAutopilotPlanJob({ queue, projectId, userId, channelId, planId });
  } catch {
    return { status: "pending_reconciliation", reason: "queue_unavailable", planId };
  }

  return {
    status: "queued",
    planId,
    publicationTargetCount,
    candidateCount,
    recovered: recoveredBuilding,
  };
}
