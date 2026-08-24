import {
  AUTOPILOT_JOB_ATTEMPTS,
  AUTOPILOT_JOB_BACKOFF_MS,
  normalizeAutopilotEngine,
  normalizePlanningWeeks,
  plannedPostCountForWeeks,
} from "./autopilot-config.mjs";
import { autopilotCandidateCount } from "./autopilot-candidate-selection.mjs";
import { normalizeAutopilotQuickSettings } from "./autopilot-style.mjs";

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
      `select plan.id, plan.project_id, plan.user_id, plan.channel_id
         from autopilot_plan plan
         join channels channel
           on channel.id = plan.channel_id and channel.project_id = plan.project_id
          and channel.network = 'tg' and channel.is_active = true
         join project_members member
           on member.project_id = plan.project_id and member.user_id = plan.user_id
          and member.status = 'active' and member.role in ('owner','author','approver')
        where plan.status = 'building'
        order by plan.build_activity_at nulls first, plan.created_at, plan.id
        limit $1`,
      [boundedLimit],
    )
  ).rows;
  const result = { scanned: rows.length, enqueued: 0, pending: 0 };
  for (const row of rows) {
    try {
      await dispatchAutopilotPlanJob({
        queue,
        projectId: row.project_id,
        userId: row.user_id,
        channelId: row.channel_id,
        planId: row.id,
      });
      result.enqueued++;
    } catch {
      // Keep the durable building row authoritative. The next reconciliation tick retries
      // the same deterministic job id without losing or duplicating the plan.
      result.pending++;
    }
  }
  return result;
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
        `select id, status, items, expected_post_count, publication_target_count, candidate_count
           from autopilot_plan
          where project_id = $1 and channel_id = $2
            and status in ('building', 'pending', 'approved', 'approving')
          order by created_at desc, id desc`,
        [projectId, channelId],
      )
    ).rows;
    const buildingPlan = plans.find((plan) => plan.status === "building");
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

    if (!recoveredBuilding) {
      const activePlan = plans.find((plan) => ["pending", "approved", "approving"].includes(plan.status));
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
