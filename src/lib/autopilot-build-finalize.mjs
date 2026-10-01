/**
 * A build lives in two rows while it runs: the `building` placeholder created by
 * `POST /api/autopilot/generate` (and by the weekly scheduler), which the interface polls,
 * and the plan row that receives the finished result. The placeholder must be closed in the
 * very transaction that commits the result.
 *
 * Leaving it open is not cosmetic. The page keeps polling a build that already finished
 * («Готово 5 из 5», бесконечный спиннер), and the 30-second reconciler treats the row as
 * unfinished work: it re-dispatches the whole plan, so Autopilot generates the same week
 * again and again, each pass paying the model and leaving the placeholder behind anew.
 */

// A plan row in one of these states is a committed result for its channel: the build that
// owns it has already written what it promised.
export const AUTOPILOT_COMMITTED_RESULT_STATUSES = ["pending", "approved", "approving"];

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`autopilot_finalize_invalid_${name}`);
  }
  return number;
}

/**
 * SQL fragment: a committed result row for the same channel that was written after `alias`.
 * A build in flight never has one — the result row is inserted exactly once, when the build
 * finishes — so its presence means the placeholder is a leftover from a finished build.
 */
export function committedAutopilotResultExistsSql(alias = "plan") {
  const source = String(alias);
  return `exists (
            select 1 from autopilot_plan committed
             where committed.project_id = ${source}.project_id
               and committed.channel_id = ${source}.channel_id
               and committed.status in (${AUTOPILOT_COMMITTED_RESULT_STATUSES
                 .map((status) => `'${status}'`)
                 .join(", ")})
               and (committed.created_at, committed.id) > (${source}.created_at, ${source}.id)
          )`;
}

/**
 * Closes one build placeholder. Only the exact `building` row is touched, so a concurrent
 * retry for the same channel can never be finalized by mistake; losing the race simply
 * reports `finalized: false` and leaves the row to whoever owns it now.
 */
export async function finalizeAutopilotBuildPlaceholder(client, {
  projectId,
  channelId,
  planId,
  resultPlanId = null,
}) {
  if (!client?.query) throw new Error("autopilot_finalize_dependencies_missing");
  const scope = {
    projectId: positiveInteger(projectId, "project_id"),
    channelId: positiveInteger(channelId, "channel_id"),
    planId: positiveInteger(planId, "plan_id"),
  };
  const result = Number(resultPlanId);
  const patch = Number.isSafeInteger(result) && result > 0 ? JSON.stringify({ resultPlanId: result }) : "{}";
  const updated = await client.query(
    `update autopilot_plan
        set status = 'done', terminal_outcome = 'complete',
            build_report = coalesce(build_report, '{}'::jsonb) || $4::jsonb,
            revision = revision + 1
      where id = $1 and project_id = $2 and channel_id = $3 and status = 'building'
      returning id`,
    [scope.planId, scope.projectId, scope.channelId, patch],
  );
  return { finalized: Number(updated?.rowCount || 0) > 0 };
}

/**
 * After a result is committed, earlier unfinished attempts for the same channel are history:
 * they stay as archive (`done`) instead of resurfacing in the interface as an «Сборка
 * остановилась» card directly above the plan that has just been built.
 *
 * A plan referenced by the approved monthly campaign is lineage, not an attempt: it keeps its
 * status so the monthly recovery can still finish its own items.
 */
export async function supersedeAutopilotAttempts(client, {
  projectId,
  channelId,
  keepPlanId = null,
}) {
  if (!client?.query) throw new Error("autopilot_finalize_dependencies_missing");
  const scope = {
    projectId: positiveInteger(projectId, "project_id"),
    channelId: positiveInteger(channelId, "channel_id"),
  };
  const keep = Number(keepPlanId);
  const updated = await client.query(
    `update autopilot_plan
        set status = 'done', revision = revision + 1
      where project_id = $1 and channel_id = $2
        and ($3::bigint is null or id <> $3::bigint)
        and status in ('error', 'partial')
        and not exists (
          select 1 from monthly_campaign_items monthly_item
           where monthly_item.weekly_autopilot_plan_id = autopilot_plan.id
        )`,
    [
      scope.projectId,
      scope.channelId,
      Number.isSafeInteger(keep) && keep > 0 ? keep : null,
    ],
  );
  return { superseded: Number(updated?.rowCount || 0) };
}
