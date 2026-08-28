import { createHash, randomUUID } from "node:crypto";

export const MONTHLY_CAMPAIGN_REGENERATION_QUEUE = "monthly-campaign-regeneration";
export const MONTHLY_CAMPAIGN_REGENERATION_DUPLICATE_THRESHOLD = 0.78;

const terminalStatuses = new Set(["completed", "stale", "failed", "cancelled"]);
const retryableStatuses = new Set(["pending", "processing", "retryable_failed"]);
const MAX_REGENERATION_DELIVERY_ATTEMPTS = 3;
const funnelStages = new Set(["awareness", "consideration", "consultation"]);
const itemStates = new Set(["topic", "detailed"]);

const positiveInteger = (value, label) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`invalid ${label}`);
  return number;
};

const boundedInteger = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.trunc(number))) : fallback;
};

const dateOnly = (value) => {
  if (typeof value === "string") return value.slice(0, 10);
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, "0"),
      String(value.getDate()).padStart(2, "0"),
    ].join("-");
  }
  return new Date(value).toISOString().slice(0, 10);
};

const parseJson = (value, fallback) => {
  if (typeof value !== "string") return value ?? fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const hashJson = (value) => createHash("sha256")
  .update(JSON.stringify(value), "utf8")
  .digest("hex");

const cleanText = (value, max, label) => {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (!text || text.length > max) throw new TypeError(`invalid ${label}`);
  return text;
};

const titleTokens = (value) => new Set(
  String(value ?? "")
    .toLocaleLowerCase("ru-RU")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 1),
);

export function monthlyCampaignTitleSimilarity(leftValue, rightValue) {
  const left = titleTokens(leftValue);
  const right = titleTokens(rightValue);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return overlap / (left.size + right.size - overlap);
}

export function monthlyCampaignTitleConflicts(
  title,
  candidates,
  threshold = MONTHLY_CAMPAIGN_REGENERATION_DUPLICATE_THRESHOLD,
) {
  return (Array.isArray(candidates) ? candidates : []).some(
    (candidate) => monthlyCampaignTitleSimilarity(title, candidate) >= threshold,
  );
}

export function monthlyRegenerationJobId(operationIdValue) {
  return `monthly-campaign-regeneration-${positiveInteger(operationIdValue, "operation id")}`;
}

async function readContext(db, projectId, operationId) {
  const operation = (
    await db.query(
      `select operation.id, operation.project_id, operation.campaign_id, operation.plan_id,
              operation.requested_by_user_id, operation.scope, operation.week_starts_on,
              operation.base_plan_version, operation.base_brief_hash,
              operation.base_profile_hash, operation.status, operation.result_plan_id,
              campaign.goal, campaign.starts_on::text as starts_on,
              campaign.ends_on::text as ends_on, campaign.timezone,
              campaign.rubrics, campaign.practice_mix, campaign.audience,
              campaign.funnel_stages, campaign.posts_per_week, campaign.important_dates,
              campaign.ctas, campaign.metrics, campaign.profile_version,
              campaign.content_brief_version, campaign.profile_hash, campaign.brief_hash,
              campaign.version as campaign_version, campaign.is_archived,
              plan.revision as plan_revision, plan.version as plan_version,
              plan.status as plan_status, plan.source_campaign_version,
              plan.source_brief_hash, plan.source_profile_hash
         from monthly_campaign_regeneration_operations operation
         join monthly_campaigns campaign
           on campaign.id = operation.campaign_id and campaign.project_id = operation.project_id
         join monthly_campaign_plans plan
           on plan.id = operation.plan_id and plan.campaign_id = operation.campaign_id
          and plan.project_id = operation.project_id
        where operation.id = $1 and operation.project_id = $2
        limit 1`,
      [operationId, projectId],
    )
  ).rows?.[0];
  if (!operation) return null;
  if (terminalStatuses.has(String(operation.status))) {
    return { operation, items: [], targets: [], historicalTitles: [], profileHash: "" };
  }

  const items = (
    await db.query(
      `select item.id, item.project_id, item.plan_id, item.item_key,
              item.scheduled_for::text as scheduled_for,
              item.position, item.title, item.rubric, item.practice, item.funnel_stage,
              item.state, item.approval_status, item.content_version,
              item.approved_content_version, item.source_item_id,
              item.weekly_autopilot_plan_id, item.weekly_autopilot_item_index,
              item.draft_id, item.post_id, item.latest_post_stats_id,
              item.regeneration_version, item.regeneration_status,
              target.item_content_version as target_content_version,
              target.item_regeneration_version as target_regeneration_version,
              (target.item_id is not null) as targeted
         from monthly_campaign_items item
         left join monthly_campaign_regeneration_targets target
           on target.operation_id = $1 and target.project_id = item.project_id
          and target.item_id = item.id
        where item.plan_id = $2 and item.project_id = $3
        order by item.scheduled_for, item.position, item.id`,
      [operationId, operation.plan_id, projectId],
    )
  ).rows ?? [];
  const profileRows = (
    await db.query(
      `select channel_id, niche, audience, rubrics, formats, author_role, goal, cta, taboo,
              profile_answers, quality, ready, source, updated_at
         from content_brief
        where project_id = $1
        order by channel_id`,
      [projectId],
    )
  ).rows ?? [];
  const historicalTitles = (
    await db.query(
      `select candidate.title
         from (
           select item.title::text as title, item.updated_at as found_at
             from monthly_campaign_items item
            where item.project_id = $1 and item.plan_id <> $2
           union all
           select coalesce(nullif(btrim(saved.source_title), ''), left(saved.text, 240)) as title,
                  saved.created_at as found_at
             from saved_posts saved
             join channels channel
               on channel.id = saved.channel_id and channel.project_id = $1
         ) candidate
        where length(btrim(candidate.title)) > 0
        order by candidate.found_at desc
        limit 4000`,
      [projectId, operation.plan_id],
    )
  ).rows?.map((row) => String(row.title)) ?? [];
  return {
    operation,
    items,
    targets: items.filter((item) => item.targeted === true),
    historicalTitles,
    profileHash: hashJson(profileRows),
  };
}

async function lockMutableContext(db, projectId, operationId) {
  // Monthly mutations already take source campaign/plan/items before they insert rows with
  // a project FK. Keep that order here, then lock the profile namespace. Reversing it would
  // let this worker hold projects while waiting for a plan whose editor waits for projects.
  const source = await db.query(
    `select campaign.id, plan.id as plan_id
       from monthly_campaign_regeneration_operations operation
       join monthly_campaigns campaign
         on campaign.id = operation.campaign_id and campaign.project_id = operation.project_id
       join monthly_campaign_plans plan
         on plan.id = operation.plan_id and plan.campaign_id = operation.campaign_id
        and plan.project_id = operation.project_id
      where operation.id = $1 and operation.project_id = $2
      for update of campaign, plan`,
    [operationId, projectId],
  );
  if (!source.rowCount) return false;
  await db.query(
    `select item.id
       from monthly_campaign_items item
       join monthly_campaign_regeneration_operations operation
         on operation.plan_id = item.plan_id and operation.project_id = item.project_id
      where operation.id = $1 and operation.project_id = $2
      order by item.id
      for update of item`,
    [operationId, projectId],
  );
  const activeProject = await db.query(
    `select project.id from projects project
      where project.id = $1 and project.is_archived = false
      for share`,
    [projectId],
  );
  if (!activeProject.rowCount) return false;
  // A table SHARE lock is brief and blocks every INSERT/UPDATE/DELETE regardless of
  // whether a channel already has a profile row. Project FOR SHARE is compatible with
  // FK key-share checks, so an in-flight brief upsert can always finish before this waits.
  await db.query("lock table content_brief in share mode");
  return true;
}

function staleReason(context) {
  const { operation, items, targets, profileHash } = context;
  if (operation.is_archived === true) return "campaign_archived";
  if (Number(operation.plan_version) !== Number(operation.base_plan_version) + 1) {
    return "plan_version_changed";
  }
  if (
    String(operation.brief_hash) !== String(operation.base_brief_hash)
    || String(operation.source_brief_hash) !== String(operation.base_brief_hash)
  ) return "brief_changed";
  if (
    String(operation.profile_hash) !== String(operation.base_profile_hash)
    || String(operation.source_profile_hash) !== String(operation.base_profile_hash)
    || profileHash !== String(operation.base_profile_hash)
  ) return "profile_changed";
  if (!targets.length) return "targets_missing";
  if (targets.some((item) => Number(item.content_version) !== Number(item.target_content_version))) {
    return "target_version_changed";
  }
  if (targets.some(
    (item) => Number(item.regeneration_version) !== Number(item.target_regeneration_version),
  )) return "target_regeneration_changed";
  if (items.some((item) => Number(item.project_id) !== Number(operation.project_id))) {
    return "project_mismatch";
  }
  return null;
}

function normalizeGeneratedItems(context, generatedValue) {
  if (!Array.isArray(generatedValue) || generatedValue.length !== context.targets.length) {
    throw new TypeError("monthly regeneration returned an incomplete result");
  }
  const campaignRubrics = new Set(parseJson(context.operation.rubrics, []).map(String));
  const practices = new Set(
    parseJson(context.operation.practice_mix, []).map((item) => String(item?.name ?? "")),
  );
  const allowedFunnels = new Set(parseJson(context.operation.funnel_stages, []).map(String));
  const targetIds = new Set(context.targets.map((item) => Number(item.id)));
  const normalized = generatedValue.map((item) => {
    const itemId = positiveInteger(item?.itemId, "generated item id");
    if (!targetIds.has(itemId)) throw new TypeError("monthly regeneration returned a foreign item");
    const title = cleanText(item?.title, 240, "generated title");
    const rubric = cleanText(item?.rubric, 120, "generated rubric");
    const practice = cleanText(item?.practice, 160, "generated practice");
    const funnelStage = cleanText(item?.funnelStage, 24, "generated funnel stage");
    const state = cleanText(item?.state ?? "topic", 16, "generated state");
    if (!campaignRubrics.has(rubric)) throw new TypeError("generated rubric is outside campaign brief");
    if (!practices.has(practice)) throw new TypeError("generated practice is outside campaign brief");
    if (!funnelStages.has(funnelStage) || !allowedFunnels.has(funnelStage)) {
      throw new TypeError("generated funnel stage is outside campaign brief");
    }
    if (!itemStates.has(state)) throw new TypeError("invalid generated state");
    return { itemId, title, rubric, practice, funnelStage, state };
  });
  if (new Set(normalized.map((item) => item.itemId)).size !== context.targets.length) {
    throw new TypeError("monthly regeneration returned duplicate items");
  }
  const untouchedTitles = context.items
    .filter((item) => item.targeted !== true)
    .map((item) => String(item.title));
  const acceptedTitles = [...context.historicalTitles, ...untouchedTitles];
  for (const item of normalized) {
    const source = context.targets.find((target) => Number(target.id) === item.itemId);
    if (monthlyCampaignTitleConflicts(item.title, [source?.title])) {
      throw new TypeError("monthly regeneration repeated the source topic");
    }
    if (monthlyCampaignTitleConflicts(item.title, acceptedTitles)) {
      throw new TypeError("monthly regeneration returned duplicate topics");
    }
    acceptedTitles.push(item.title);
  }
  return normalized;
}

export function buildMonthlyRegenerationRevisionItems(items, generated) {
  const generatedById = new Map(generated.map((item) => [Number(item.itemId), item]));
  return items.map((item) => {
    const replacement = generatedById.get(Number(item.id));
    return {
      item_key: item.item_key,
      scheduled_for: dateOnly(item.scheduled_for),
      position: Number(item.position),
      title: replacement?.title ?? String(item.title),
      rubric: replacement?.rubric ?? String(item.rubric),
      practice: replacement?.practice ?? String(item.practice),
      funnel_stage: replacement?.funnelStage ?? String(item.funnel_stage),
      state: replacement?.state ?? String(item.state),
      approval_status: replacement ? "draft" : String(item.approval_status),
      content_version: replacement ? Number(item.content_version) + 1 : Number(item.content_version),
      approved_content_version: replacement ? null : item.approved_content_version,
      source_item_id: Number(item.id),
      weekly_autopilot_plan_id: replacement ? null : item.weekly_autopilot_plan_id,
      weekly_autopilot_item_index: replacement ? null : item.weekly_autopilot_item_index,
      draft_id: replacement ? null : item.draft_id,
      post_id: replacement ? null : item.post_id,
      latest_post_stats_id: replacement ? null : item.latest_post_stats_id,
      regeneration_version: Math.max(0, Number(item.regeneration_version) || 0),
    };
  });
}

async function markOperation(pool, projectId, operationId, status, errorCode) {
  const retryable = status === "retryable_failed";
  const tx = await pool.connect();
  try {
    await tx.query("begin");
    const delivery = retryable
      ? await tx.query(
        `select attempts
           from monthly_campaign_regeneration_outbox
          where operation_id = $1 and project_id = $2
          for update`,
        [operationId, projectId],
      )
      : { rows: [] };
    const effectiveStatus = retryable
      && Number(delivery.rows?.[0]?.attempts ?? 0) < MAX_REGENERATION_DELIVERY_ATTEMPTS
      ? "retryable_failed"
      : status === "retryable_failed" ? "failed" : status;
    const outboxStatus = effectiveStatus === "retryable_failed" ? "retryable_failed" : "failed";
    const marked = await tx.query(
      `update monthly_campaign_regeneration_operations
          set status = $3, error_code = $4, updated_at = now(),
              completed_at = case when $3 in ('stale','failed','cancelled') then now() else null end
        where id = $1 and project_id = $2
          and status in ('pending','processing','retryable_failed')
        returning id`,
      [operationId, projectId, effectiveStatus, String(errorCode || "regeneration_failed").slice(0, 100)],
    );
    if (marked.rowCount !== 1) {
      await tx.query("rollback");
      return false;
    }
    await tx.query(
      `update monthly_campaign_items item
          set regeneration_status = 'failed', updated_at = now()
         from monthly_campaign_regeneration_targets target
        where target.operation_id = $1 and target.project_id = $2
          and item.id = target.item_id and item.project_id = target.project_id
          and item.regeneration_version = target.item_regeneration_version`,
      [operationId, projectId],
    );
    await tx.query(
      `update monthly_campaign_regeneration_outbox
          set status = $3, attempts = attempts + 1,
              next_attempt_at = case when $3 = 'retryable_failed'
                then now() + make_interval(secs => least(900, 15 * (attempts + 1)))
                else next_attempt_at end,
              lease_token = null, lease_expires_at = null,
              last_error_code = $4, updated_at = now()
        where operation_id = $1 and project_id = $2`,
      [operationId, projectId, outboxStatus, String(errorCode || "regeneration_failed").slice(0, 100)],
    );
    await tx.query("commit");
    return true;
  } catch (error) {
    await tx.query("rollback").catch(() => {});
    throw error;
  } finally {
    tx.release();
  }
}

export async function processMonthlyCampaignRegeneration({
  pool,
  projectId: projectIdValue,
  operationId: operationIdValue,
  generate,
  commitUsage = null,
}) {
  const projectId = positiveInteger(projectIdValue, "project id");
  const operationId = positiveInteger(operationIdValue, "operation id");
  if (typeof generate !== "function") throw new TypeError("monthly regeneration generator is required");
  if (commitUsage != null && typeof commitUsage !== "function") {
    throw new TypeError("monthly regeneration usage committer must be a function");
  }

  let context = await readContext(pool, projectId, operationId);
  if (!context) return { state: "missing" };
  const currentStatus = String(context.operation.status);
  if (currentStatus === "completed") {
    return { state: "completed", replayed: true, planId: Number(context.operation.result_plan_id) };
  }
  if (terminalStatuses.has(currentStatus)) return { state: currentStatus, replayed: true };
  if (!retryableStatuses.has(currentStatus)) return { state: "ineligible" };
  const initialStaleReason = staleReason(context);
  if (initialStaleReason) {
    await markOperation(pool, projectId, operationId, "stale", initialStaleReason);
    return { state: "stale", reason: initialStaleReason };
  }

  const claimed = await pool.query(
    `update monthly_campaign_regeneration_operations
        set status = 'processing', error_code = null, updated_at = now(), completed_at = null
      where id = $1 and project_id = $2 and status in ('pending','processing','retryable_failed')
      returning id`,
    [operationId, projectId],
  );
  if (!claimed.rowCount) return { state: "ineligible" };
  const processingTargets = await pool.query(
    `update monthly_campaign_items item
        set regeneration_status = 'processing', updated_at = now()
       from monthly_campaign_regeneration_targets target
      where target.operation_id = $1 and target.project_id = $2
        and item.id = target.item_id and item.project_id = target.project_id
        and item.regeneration_version = target.item_regeneration_version`,
    [operationId, projectId],
  );
  if (processingTargets.rowCount !== context.targets.length) {
    await markOperation(
      pool,
      projectId,
      operationId,
      "stale",
      "target_regeneration_changed",
    );
    return { state: "stale", reason: "target_regeneration_changed" };
  }

  let generated;
  try {
    generated = normalizeGeneratedItems(context, await generate({
      projectId,
      operationId,
      campaign: context.operation,
      items: context.items,
      targets: context.targets,
      historicalTitles: context.historicalTitles,
    }));
  } catch (error) {
    await markOperation(
      pool,
      projectId,
      operationId,
      "retryable_failed",
      error?.code || "generation_failed",
    );
    throw error;
  }

  const tx = await pool.connect();
  try {
    await tx.query("begin");
    const locked = (
      await tx.query(
        `select status, result_plan_id
           from monthly_campaign_regeneration_operations
          where id = $1 and project_id = $2 for update`,
        [operationId, projectId],
      )
    ).rows?.[0];
    if (!locked) {
      await tx.query("rollback");
      return { state: "missing" };
    }
    if (locked.status === "completed") {
      await tx.query("rollback");
      return { state: "completed", replayed: true, planId: Number(locked.result_plan_id) };
    }
    if (locked.status !== "processing") {
      await tx.query("rollback");
      return { state: String(locked.status), replayed: true };
    }
    if (!await lockMutableContext(tx, projectId, operationId)) {
      await tx.query("rollback");
      await markOperation(pool, projectId, operationId, "stale", "operation_missing");
      return { state: "stale", reason: "operation_missing" };
    }
    context = await readContext(tx, projectId, operationId);
    const finalStaleReason = context && staleReason(context);
    if (!context || finalStaleReason) {
      await tx.query("rollback");
      await markOperation(pool, projectId, operationId, "stale", finalStaleReason || "operation_missing");
      return { state: "stale", reason: finalStaleReason || "operation_missing" };
    }

    const revision = Number((
      await tx.query(
        `select coalesce(max(revision), 0) + 1 as next_revision
           from monthly_campaign_plans
          where campaign_id = $1 and project_id = $2`,
        [context.operation.campaign_id, projectId],
      )
    ).rows?.[0]?.next_revision ?? 1);
    const requestKey = `regeneration:${operationId}`;
    const requestHash = hashJson({ operationId, generated });
    const plan = (
      await tx.query(
        `insert into monthly_campaign_plans (
           project_id, campaign_id, revision, status, source_campaign_version,
           source_brief_hash, source_profile_hash, source_profile_version,
           source_content_brief_version, request_key, request_hash, created_by_user_id
         ) values ($1, $2, $3, 'draft', $4, $5, $6, $7, $8, $9, $10, $11)
         returning id`,
        [
          projectId,
          context.operation.campaign_id,
          revision,
          context.operation.campaign_version,
          context.operation.base_brief_hash,
          context.operation.base_profile_hash,
          context.operation.profile_version,
          context.operation.content_brief_version,
          requestKey,
          requestHash,
          context.operation.requested_by_user_id,
        ],
      )
    ).rows?.[0];
    if (!plan) throw new Error("monthly regeneration plan was not created");
    const copiedItems = buildMonthlyRegenerationRevisionItems(context.items, generated);
    const inserted = await tx.query(
      `insert into monthly_campaign_items (
         project_id, plan_id, item_key, scheduled_for, position, title, rubric, practice,
         funnel_stage, state, approval_status, content_version, approved_content_version,
         source_item_id, weekly_autopilot_plan_id, weekly_autopilot_item_index,
         draft_id, post_id, latest_post_stats_id, regeneration_version, regeneration_status
       )
       select $1, $2, item.item_key, item.scheduled_for::date, item.position,
              item.title, item.rubric, item.practice, item.funnel_stage, item.state,
              item.approval_status, item.content_version, item.approved_content_version,
              item.source_item_id, item.weekly_autopilot_plan_id,
              item.weekly_autopilot_item_index, item.draft_id, item.post_id,
              item.latest_post_stats_id, item.regeneration_version, 'idle'
         from jsonb_to_recordset($3::jsonb) as item(
           item_key text, scheduled_for text, position integer, title text, rubric text,
           practice text, funnel_stage text, state text, approval_status text,
           content_version bigint, approved_content_version bigint, source_item_id bigint,
           weekly_autopilot_plan_id bigint, weekly_autopilot_item_index integer,
           draft_id bigint, post_id bigint, latest_post_stats_id bigint,
           regeneration_version bigint
         )
       returning id`,
      [projectId, Number(plan.id), JSON.stringify(copiedItems)],
    );
    if (inserted.rows.length !== copiedItems.length) {
      throw new Error("monthly regeneration items were not copied");
    }
    const completed = await tx.query(
      `update monthly_campaign_regeneration_operations
          set status = 'completed', result_plan_id = $3, error_code = null,
              updated_at = now(), completed_at = now()
        where id = $1 and project_id = $2 and status = 'processing'`,
      [operationId, projectId, Number(plan.id)],
    );
    if (completed.rowCount !== 1) throw new Error("monthly regeneration operation lease lost");
    const releasedTargets = await tx.query(
      `update monthly_campaign_items item
          set regeneration_status = 'idle', updated_at = now()
         from monthly_campaign_regeneration_targets target
        where target.operation_id = $1 and target.project_id = $2
          and item.id = target.item_id and item.project_id = target.project_id
          and item.regeneration_version = target.item_regeneration_version`,
      [operationId, projectId],
    );
    if (releasedTargets.rowCount !== context.targets.length) {
      throw new Error("monthly regeneration target lease lost");
    }
    await tx.query(
      `update monthly_campaign_regeneration_outbox
          set status = 'enqueued', lease_token = null, lease_expires_at = null,
              last_error_code = null, updated_at = now()
        where operation_id = $1 and project_id = $2`,
      [operationId, projectId],
    );
    await tx.query(
      `insert into audit_events (
         project_id, actor_user_id, action, entity_type, entity_id,
         before_version, after_version, safe_data, idempotency_key
       ) values (
         $1, $2, 'monthly_campaign.regeneration_completed', 'monthly_campaign_plan', $3::text,
         $4, 1, jsonb_build_object('operation_id', $5::bigint,
           'source_plan_id', $6::bigint, 'target_count', $7::int,
           'source_revision', $8::bigint, 'result_revision', $9::bigint), $10
       ) on conflict do nothing`,
      [
        projectId,
        context.operation.requested_by_user_id,
        Number(plan.id),
        context.operation.base_plan_version,
        operationId,
        context.operation.plan_id,
        context.targets.length,
        context.operation.plan_revision,
        revision,
        `monthly-campaign:regeneration-completed:${operationId}`,
      ],
    );
    if (commitUsage && await commitUsage(tx) !== true) {
      const error = new Error("monthly regeneration AI usage reservation expired");
      error.code = "AI_USAGE_FINALIZE_FAILED";
      throw error;
    }
    await tx.query("commit");
    return { state: "completed", replayed: false, planId: Number(plan.id), revision };
  } catch (error) {
    await tx.query("rollback").catch(() => {});
    await markOperation(
      pool,
      projectId,
      operationId,
      "retryable_failed",
      error?.code || "persistence_failed",
    ).catch(() => {});
    throw error;
  } finally {
    tx.release();
  }
}

export async function reconcileMonthlyCampaignRegenerationOutbox({
  pool,
  enqueue,
  limit = 100,
  leaseSeconds = 300,
  redeliverySeconds = 60,
}) {
  if (typeof enqueue !== "function") throw new TypeError("monthly regeneration enqueue is required");
  const boundedLimit = boundedInteger(limit, 100, 1, 1_000);
  const boundedLease = boundedInteger(leaseSeconds, 300, 30, 3_600);
  const boundedRedelivery = boundedInteger(redeliverySeconds, 60, 30, 3_600);
  const candidates = (
    await pool.query(
      `select outbox.id, outbox.operation_id, outbox.project_id
         from monthly_campaign_regeneration_outbox outbox
         join monthly_campaign_regeneration_operations operation
           on operation.id = outbox.operation_id and operation.project_id = outbox.project_id
        where outbox.next_attempt_at <= now()
          and (
            outbox.status in ('pending','retryable_failed')
            or (outbox.status = 'dispatching' and outbox.lease_expires_at < now())
            or (outbox.status = 'enqueued'
                and outbox.updated_at < now() - make_interval(secs => $2::int))
          )
          and operation.status in ('pending','processing','retryable_failed')
        order by outbox.next_attempt_at, outbox.id
        limit $1`,
      [boundedLimit, boundedRedelivery],
    )
  ).rows ?? [];
  let enqueued = 0;
  let pending = 0;
  for (const candidate of candidates) {
    const leaseToken = randomUUID();
    const claimed = await pool.query(
      `update monthly_campaign_regeneration_outbox
          set status = 'dispatching', lease_token = $3,
              lease_expires_at = now() + make_interval(secs => $4::int), updated_at = now()
        where id = $1 and project_id = $2 and next_attempt_at <= now()
          and (
            status in ('pending','retryable_failed')
            or (status = 'dispatching' and lease_expires_at < now())
            or (status = 'enqueued'
                and updated_at < now() - make_interval(secs => $5::int))
          )
        returning operation_id`,
      [candidate.id, candidate.project_id, leaseToken, boundedLease, boundedRedelivery],
    );
    if (!claimed.rowCount) continue;
    try {
      await enqueue(Number(candidate.project_id), Number(candidate.operation_id));
      const acknowledged = await pool.query(
        `update monthly_campaign_regeneration_outbox
            set status = 'enqueued', attempts = attempts + 1, enqueued_at = coalesce(enqueued_at, now()),
                lease_token = null, lease_expires_at = null, last_error_code = null, updated_at = now()
          where id = $1 and project_id = $2 and lease_token = $3`,
        [candidate.id, candidate.project_id, leaseToken],
      );
      if (acknowledged.rowCount) enqueued += 1;
      else pending += 1;
    } catch (error) {
      pending += 1;
      await pool.query(
        `update monthly_campaign_regeneration_outbox
            set status = 'retryable_failed', attempts = attempts + 1,
                next_attempt_at = now() + make_interval(secs => least(900, 15 * (attempts + 1))),
                lease_token = null, lease_expires_at = null, last_error_code = $4, updated_at = now()
          where id = $1 and project_id = $2 and lease_token = $3`,
        [candidate.id, candidate.project_id, leaseToken, String(error?.code || "queue_unavailable").slice(0, 100)],
      ).catch(() => {});
    }
  }
  return { scanned: candidates.length, enqueued, pending };
}

export async function recoverStaleMonthlyCampaignRegenerations({
  pool,
  staleSeconds = 1_800,
}) {
  const boundedStale = boundedInteger(staleSeconds, 1_800, 300, 86_400);
  const tx = await pool.connect();
  try {
    await tx.query("begin");
    const stale = await tx.query(
      `update monthly_campaign_regeneration_operations
          set status = 'retryable_failed', error_code = 'worker_interrupted', updated_at = now()
        where status = 'processing'
          and updated_at < now() - make_interval(secs => $1::int)
        returning id, project_id`,
      [boundedStale],
    );
    if (stale.rows.length) {
      const operationIds = stale.rows.map((row) => Number(row.id));
      await tx.query(
        `update monthly_campaign_regeneration_outbox
            set status = 'retryable_failed', next_attempt_at = now(),
                lease_token = null, lease_expires_at = null,
                last_error_code = 'worker_interrupted', updated_at = now()
          where operation_id = any($1::bigint[])`,
        [operationIds],
      );
      await tx.query(
        `update monthly_campaign_items item
            set regeneration_status = 'failed', updated_at = now()
           from monthly_campaign_regeneration_targets target
          where target.operation_id = any($1::bigint[])
            and item.id = target.item_id and item.project_id = target.project_id
            and item.regeneration_version = target.item_regeneration_version`,
        [operationIds],
      );
    }
    await tx.query("commit");
    return { recovered: stale.rows.length };
  } catch (error) {
    await tx.query("rollback").catch(() => {});
    throw error;
  } finally {
    tx.release();
  }
}
