import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import {
  ProjectAccessError,
  requireSelectedProjectPermission,
  type ProjectPermission,
} from "./project-permissions";
import { normalizeIdempotencyKey } from "./publication-idempotency";
import { titleSimilarity } from "./monthly-campaign";

export const MONTHLY_CAMPAIGN_FUNNEL_STAGES = [
  "awareness",
  "consideration",
  "consultation",
] as const;
export type MonthlyCampaignFunnelStage = (typeof MONTHLY_CAMPAIGN_FUNNEL_STAGES)[number];
export type MonthlyCampaignPlanStatus = "draft" | "in_review" | "approved";
export type MonthlyCampaignItemState = "topic" | "detailed";
export type MonthlyCampaignRegenerationScope = "item" | "week";

type TransactionPool = Pick<Pool, "connect">;
type QueryPool = Pick<Pool, "query">;

type PracticeMixItem = {
  name: string;
  kind: "practice" | "service";
  weight: number;
};

type ImportantDate = { date: string; label: string };

export type NormalizedMonthlyCampaignBrief = {
  goal: string;
  startsOn: string;
  endsOn: string;
  timezone: string;
  rubrics: string[];
  practiceMix: PracticeMixItem[];
  audience: string;
  funnelStages: MonthlyCampaignFunnelStage[];
  postsPerWeek: number;
  importantDates: ImportantDate[];
  ctas: string[];
  metrics: string[];
  profileVersion: number;
  contentBriefVersion: number;
};

export type NormalizedMonthlyCampaignItem = {
  itemKey: string;
  scheduledFor: string;
  position: number;
  title: string;
  rubric: string;
  practice: string;
  funnelStage: MonthlyCampaignFunnelStage;
  state: MonthlyCampaignItemState;
};

export type MonthlyCampaignSummary = {
  id: number;
  projectId: number;
  goal: string;
  startsOn: string;
  endsOn: string;
  timezone: string;
  rubrics: string[];
  practiceMix: PracticeMixItem[];
  audience: string;
  funnelStages: MonthlyCampaignFunnelStage[];
  postsPerWeek: number;
  importantDates: ImportantDate[];
  ctas: string[];
  metrics: string[];
  profileVersion: number;
  contentBriefVersion: number;
  profileHash: string;
  briefHash: string;
  version: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MonthlyCampaignItemRecord = NormalizedMonthlyCampaignItem & {
  id: number;
  projectId: number;
  planId: number;
  approvalStatus: MonthlyCampaignPlanStatus;
  contentVersion: number;
  approvedContentVersion: number | null;
  sourceItemId: number | null;
  weeklyAutopilotPlanId: number | null;
  weeklyAutopilotItemIndex: number | null;
  draftId: number | null;
  postId: number | null;
  latestPostStatsId: number | null;
  regenerationVersion: number;
  regenerationStatus: "idle" | "pending" | "processing" | "failed";
  createdAt: string;
  updatedAt: string;
};

export type MonthlyCampaignPlanRecord = {
  id: number;
  projectId: number;
  campaignId: number;
  revision: number;
  status: MonthlyCampaignPlanStatus;
  sourceCampaignVersion: number;
  sourceBriefHash: string;
  sourceProfileHash: string;
  sourceProfileVersion: number;
  sourceContentBriefVersion: number;
  version: number;
  submittedAt: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  stale: boolean;
  items: MonthlyCampaignItemRecord[];
};

export type MonthlyCampaignRegenerationRecord = {
  id: number;
  planId: number;
  scope: MonthlyCampaignRegenerationScope;
  weekStartsOn: string | null;
  status: "pending" | "processing" | "completed" | "stale" | "retryable_failed" | "failed" | "cancelled";
  basePlanVersion: number;
  targetItemIds: number[];
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export class MonthlyCampaignServiceError extends Error {
  readonly code:
    | "invalid_brief"
    | "invalid_timezone"
    | "timezone_mismatch"
    | "invalid_period"
    | "invalid_rubrics"
    | "invalid_practice_mix"
    | "invalid_audience"
    | "invalid_funnel_stage"
    | "invalid_frequency"
    | "invalid_important_date"
    | "invalid_cta"
    | "invalid_metric"
    | "invalid_version"
    | "invalid_idempotency_key"
    | "idempotency_conflict"
    | "not_found"
    | "version_conflict"
    | "stale_campaign"
    | "invalid_items"
    | "invalid_item"
    | "duplicate_topics"
    | "invalid_transition"
    | "invalid_move"
    | "regeneration_in_progress"
    | "invalid_regeneration_scope"
    | "no_regeneration_targets"
    | "lineage_conflict"
    | "archived";

  constructor(code: MonthlyCampaignServiceError["code"]) {
    super(code);
    this.name = "MonthlyCampaignServiceError";
    this.code = code;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function cleanText(value: unknown, max: number, code: MonthlyCampaignServiceError["code"]): string {
  if (typeof value !== "string") throw new MonthlyCampaignServiceError(code);
  const normalized = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!normalized || normalized.length > max) throw new MonthlyCampaignServiceError(code);
  return normalized;
}

function positiveVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new MonthlyCampaignServiceError("invalid_version");
  }
  return value;
}

function positiveId(value: unknown, code: MonthlyCampaignServiceError["code"] = "not_found"): number {
  const id = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new MonthlyCampaignServiceError(code);
  return id;
}

function parseDateOnly(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}

function dateMs(value: string): number {
  return new Date(`${value}T00:00:00.000Z`).getTime();
}

function enumerateDates(startsOn: string, endsOn: string): string[] {
  const result: string[] = [];
  for (let at = dateMs(startsOn), end = dateMs(endsOn); at <= end; at += 86_400_000) {
    result.push(new Date(at).toISOString().slice(0, 10));
  }
  return result;
}

function parseTimezone(value: unknown): string {
  const timezone = cleanText(value, 80, "invalid_timezone");
  try {
    new Intl.DateTimeFormat("ru-RU", { timeZone: timezone }).format(new Date());
  } catch {
    throw new MonthlyCampaignServiceError("invalid_timezone");
  }
  return timezone;
}

function parseUniqueStrings(
  value: unknown,
  input: { min: number; max: number; textMax: number; code: MonthlyCampaignServiceError["code"] },
): string[] {
  if (!Array.isArray(value) || value.length < input.min || value.length > input.max) {
    throw new MonthlyCampaignServiceError(input.code);
  }
  const items = value.map((item) => cleanText(item, input.textMax, input.code));
  const keys = items.map((item) => item.toLocaleLowerCase("ru-RU"));
  if (new Set(keys).size !== keys.length) throw new MonthlyCampaignServiceError(input.code);
  return items;
}

function parsePracticeMix(value: unknown): PracticeMixItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) {
    throw new MonthlyCampaignServiceError("invalid_practice_mix");
  }
  const items = value.map((candidate) => {
    const item = asObject(candidate);
    if (!item || !hasExactKeys(item, ["name", "kind", "weight"])) {
      throw new MonthlyCampaignServiceError("invalid_practice_mix");
    }
    const name = cleanText(item.name, 160, "invalid_practice_mix");
    if (item.kind !== "practice" && item.kind !== "service") {
      throw new MonthlyCampaignServiceError("invalid_practice_mix");
    }
    if (typeof item.weight !== "number" || !Number.isInteger(item.weight) || item.weight < 1 || item.weight > 100) {
      throw new MonthlyCampaignServiceError("invalid_practice_mix");
    }
    return { name, kind: item.kind as PracticeMixItem["kind"], weight: item.weight };
  });
  if (new Set(items.map((item) => item.name.toLocaleLowerCase("ru-RU"))).size !== items.length) {
    throw new MonthlyCampaignServiceError("invalid_practice_mix");
  }
  if (items.reduce((sum, item) => sum + item.weight, 0) !== 100) {
    throw new MonthlyCampaignServiceError("invalid_practice_mix");
  }
  return items;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function normalizeMonthlyCampaignBrief(value: unknown): NormalizedMonthlyCampaignBrief {
  const brief = asObject(value);
  if (!brief || !hasExactKeys(brief, [
    "goal", "startsOn", "endsOn", "timezone", "rubrics", "practiceMix", "audience",
    "funnelStages", "postsPerWeek", "importantDates", "ctas", "metrics",
    "profileVersion", "contentBriefVersion",
  ])) throw new MonthlyCampaignServiceError("invalid_brief");

  const startsOn = parseDateOnly(brief.startsOn);
  const endsOn = parseDateOnly(brief.endsOn);
  if (!startsOn || !endsOn || endsOn < startsOn) throw new MonthlyCampaignServiceError("invalid_period");
  const dates = enumerateDates(startsOn, endsOn);
  if (dates.length < 28 || dates.length > 31) throw new MonthlyCampaignServiceError("invalid_period");

  const funnelStages = parseUniqueStrings(brief.funnelStages, {
    min: 1, max: 3, textMax: 24, code: "invalid_funnel_stage",
  });
  if (funnelStages.some((stage) => !MONTHLY_CAMPAIGN_FUNNEL_STAGES.includes(stage as MonthlyCampaignFunnelStage))) {
    throw new MonthlyCampaignServiceError("invalid_funnel_stage");
  }
  if (typeof brief.postsPerWeek !== "number" || !Number.isInteger(brief.postsPerWeek)
      || brief.postsPerWeek < 1 || brief.postsPerWeek > 14) {
    throw new MonthlyCampaignServiceError("invalid_frequency");
  }
  if (!Array.isArray(brief.importantDates) || brief.importantDates.length > 31) {
    throw new MonthlyCampaignServiceError("invalid_important_date");
  }
  const importantDates = brief.importantDates.map((candidate) => {
    const item = asObject(candidate);
    if (!item || !hasExactKeys(item, ["date", "label"])) {
      throw new MonthlyCampaignServiceError("invalid_important_date");
    }
    const date = parseDateOnly(item.date);
    if (!date || date < startsOn || date > endsOn) {
      throw new MonthlyCampaignServiceError("invalid_important_date");
    }
    return { date, label: cleanText(item.label, 160, "invalid_important_date") };
  }).sort((left, right) => left.date.localeCompare(right.date) || left.label.localeCompare(right.label));

  return {
    goal: cleanText(brief.goal, 500, "invalid_brief"),
    startsOn,
    endsOn,
    timezone: parseTimezone(brief.timezone),
    rubrics: parseUniqueStrings(brief.rubrics, { min: 3, max: 6, textMax: 120, code: "invalid_rubrics" }),
    practiceMix: parsePracticeMix(brief.practiceMix),
    audience: cleanText(brief.audience, 500, "invalid_audience"),
    funnelStages: funnelStages as MonthlyCampaignFunnelStage[],
    postsPerWeek: brief.postsPerWeek,
    importantDates,
    ctas: parseUniqueStrings(brief.ctas, { min: 1, max: 12, textMax: 240, code: "invalid_cta" }),
    metrics: parseUniqueStrings(brief.metrics, { min: 1, max: 12, textMax: 120, code: "invalid_metric" }),
    profileVersion: positiveVersion(brief.profileVersion),
    contentBriefVersion: positiveVersion(brief.contentBriefVersion),
  };
}

export function monthlyCampaignBriefHash(brief: NormalizedMonthlyCampaignBrief): string {
  return hashJson(brief);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value === "string") {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return (value ?? fallback) as T;
}

function iso(value: unknown): string {
  return new Date(value as string | number | Date).toISOString();
}

function dateOnly(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 10);
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, "0"),
      String(value.getDate()).padStart(2, "0"),
    ].join("-");
  }
  return iso(value).slice(0, 10);
}

function campaignFromRow(row: Record<string, unknown>): MonthlyCampaignSummary {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    goal: String(row.goal),
    startsOn: dateOnly(row.starts_on),
    endsOn: dateOnly(row.ends_on),
    timezone: String(row.timezone),
    rubrics: parseJson<string[]>(row.rubrics, []),
    practiceMix: parseJson<PracticeMixItem[]>(row.practice_mix, []),
    audience: String(row.audience),
    funnelStages: parseJson<MonthlyCampaignFunnelStage[]>(row.funnel_stages, []),
    postsPerWeek: Number(row.posts_per_week),
    importantDates: parseJson<ImportantDate[]>(row.important_dates, []),
    ctas: parseJson<string[]>(row.ctas, []),
    metrics: parseJson<string[]>(row.metrics, []),
    profileVersion: Number(row.profile_version),
    contentBriefVersion: Number(row.content_brief_version),
    profileHash: String(row.profile_hash),
    briefHash: String(row.brief_hash),
    version: Number(row.version),
    archived: row.is_archived === true,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function itemFromRow(row: Record<string, unknown>): MonthlyCampaignItemRecord {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    planId: Number(row.plan_id),
    itemKey: String(row.item_key),
    scheduledFor: dateOnly(row.scheduled_for),
    position: Number(row.position),
    title: String(row.title),
    rubric: String(row.rubric),
    practice: String(row.practice),
    funnelStage: String(row.funnel_stage) as MonthlyCampaignFunnelStage,
    state: String(row.state) as MonthlyCampaignItemState,
    approvalStatus: String(row.approval_status) as MonthlyCampaignPlanStatus,
    contentVersion: Number(row.content_version),
    approvedContentVersion: row.approved_content_version == null ? null : Number(row.approved_content_version),
    sourceItemId: row.source_item_id == null ? null : Number(row.source_item_id),
    weeklyAutopilotPlanId: row.weekly_autopilot_plan_id == null ? null : Number(row.weekly_autopilot_plan_id),
    weeklyAutopilotItemIndex: row.weekly_autopilot_item_index == null ? null : Number(row.weekly_autopilot_item_index),
    draftId: row.draft_id == null ? null : Number(row.draft_id),
    postId: row.post_id == null ? null : Number(row.post_id),
    latestPostStatsId: row.latest_post_stats_id == null ? null : Number(row.latest_post_stats_id),
    regenerationVersion: Number(row.regeneration_version),
    regenerationStatus: String(row.regeneration_status) as MonthlyCampaignItemRecord["regenerationStatus"],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function planFromRow(
  row: Record<string, unknown>,
  currentProfileHash: string,
  campaign: MonthlyCampaignSummary,
  items: MonthlyCampaignItemRecord[],
): MonthlyCampaignPlanRecord {
  const sourceBriefHash = String(row.source_brief_hash);
  const sourceProfileHash = String(row.source_profile_hash);
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    campaignId: Number(row.campaign_id),
    revision: Number(row.revision),
    status: String(row.status) as MonthlyCampaignPlanStatus,
    sourceCampaignVersion: Number(row.source_campaign_version),
    sourceBriefHash,
    sourceProfileHash,
    sourceProfileVersion: Number(row.source_profile_version),
    sourceContentBriefVersion: Number(row.source_content_brief_version),
    version: Number(row.version),
    submittedAt: row.submitted_at == null ? null : iso(row.submitted_at),
    approvedAt: row.approved_at == null ? null : iso(row.approved_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    stale: sourceBriefHash !== campaign.briefHash || sourceProfileHash !== currentProfileHash,
    items,
  };
}

async function withTransaction<T>(pool: TransactionPool, task: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await task(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function readProjectTimezone(db: Pick<PoolClient, "query">, projectId: number): Promise<string> {
  const result = await db.query<{ timezone: string }>(
    `select timezone from projects where id = $1 and is_archived = false limit 1`,
    [projectId],
  );
  if (!result.rows[0]) throw new ProjectAccessError("membership_required");
  return result.rows[0].timezone;
}

/** A server-owned digest of every current content profile in the selected project. */
export async function readProjectContentProfileHash(
  db: Pick<PoolClient, "query">,
  projectId: number,
): Promise<string> {
  const result = await db.query<Record<string, unknown>>(
    `select channel_id, niche, audience, rubrics, formats, author_role, goal, cta, taboo,
            profile_answers, quality, ready, source, updated_at
       from content_brief
      where project_id = $1
      order by channel_id`,
    [projectId],
  );
  return hashJson(result.rows);
}

async function authorizeSelected(
  db: Pick<PoolClient, "query">,
  actorUserId: number,
  permission: ProjectPermission,
): Promise<number> {
  const membership = await requireSelectedProjectPermission(db, actorUserId, permission);
  return membership.projectId;
}

function normalizeRequestKey(value: unknown): string {
  const key = normalizeIdempotencyKey(value);
  if (!key) throw new MonthlyCampaignServiceError("invalid_idempotency_key");
  return key;
}

function ensureTimezone(expected: string, received: string): void {
  if (expected !== received) throw new MonthlyCampaignServiceError("timezone_mismatch");
}

function ensureCampaignFresh(
  campaign: MonthlyCampaignSummary,
  source: Record<string, unknown>,
  currentProfileHash: string,
): void {
  if (String(source.source_brief_hash) !== campaign.briefHash
      || String(source.source_profile_hash) !== currentProfileHash
      || campaign.profileHash !== currentProfileHash) {
    throw new MonthlyCampaignServiceError("stale_campaign");
  }
}

const CAMPAIGN_SELECT = `
  select id, project_id, goal, starts_on, ends_on, timezone, rubrics, practice_mix,
         audience, funnel_stages, posts_per_week, important_dates, ctas, metrics,
         profile_version, content_brief_version, profile_hash, brief_hash, version,
         is_archived, created_at, updated_at
    from monthly_campaigns`;

const PLAN_SELECT = `
  select id, project_id, campaign_id, revision, status, source_campaign_version,
         source_brief_hash, source_profile_hash, source_profile_version,
         source_content_brief_version, version, submitted_at, approved_at,
         created_at, updated_at
    from monthly_campaign_plans`;

const ITEM_SELECT = `
  select id, project_id, plan_id, item_key, scheduled_for, position, title, rubric,
         practice, funnel_stage, state, approval_status, content_version,
         approved_content_version, source_item_id, weekly_autopilot_plan_id,
         weekly_autopilot_item_index, draft_id, post_id, latest_post_stats_id,
         regeneration_version, regeneration_status, created_at, updated_at
    from monthly_campaign_items`;

export async function listMonthlyCampaigns(input: {
  pool: QueryPool;
  actorUserId: number;
}): Promise<MonthlyCampaignSummary[]> {
  const projectId = await authorizeSelected(input.pool as Pick<PoolClient, "query">, input.actorUserId, "project.read");
  const result = await input.pool.query<Record<string, unknown>>(
    `${CAMPAIGN_SELECT}
      where project_id = $1 and is_archived = false
      order by starts_on desc, id desc`,
    [projectId],
  );
  return result.rows.map(campaignFromRow);
}

export async function getMonthlyCampaign(input: {
  pool: QueryPool;
  actorUserId: number;
  campaignId: number;
}): Promise<{
  campaign: MonthlyCampaignSummary;
  plans: MonthlyCampaignPlanRecord[];
  regenerations: MonthlyCampaignRegenerationRecord[];
}> {
  const projectId = await authorizeSelected(input.pool as Pick<PoolClient, "query">, input.actorUserId, "project.read");
  const campaignResult = await input.pool.query<Record<string, unknown>>(
    `${CAMPAIGN_SELECT} where id = $1 and project_id = $2 limit 1`,
    [positiveId(input.campaignId), projectId],
  );
  if (!campaignResult.rows[0]) throw new MonthlyCampaignServiceError("not_found");
  const campaign = campaignFromRow(campaignResult.rows[0]);
  const currentProfileHash = await readProjectContentProfileHash(input.pool as Pick<PoolClient, "query">, projectId);
  const planResult = await input.pool.query<Record<string, unknown>>(
    `${PLAN_SELECT} where campaign_id = $1 and project_id = $2 order by revision desc, id desc`,
    [campaign.id, projectId],
  );
  const planIds = planResult.rows.map((row) => Number(row.id));
  const itemResult = planIds.length
    ? await input.pool.query<Record<string, unknown>>(
      `${ITEM_SELECT} where project_id = $1 and plan_id = any($2::bigint[])
        order by plan_id, scheduled_for, position, id`,
      [projectId, planIds],
    )
    : { rows: [] };
  const itemsByPlan = new Map<number, MonthlyCampaignItemRecord[]>();
  for (const row of itemResult.rows) {
    const item = itemFromRow(row);
    const list = itemsByPlan.get(item.planId) ?? [];
    list.push(item);
    itemsByPlan.set(item.planId, list);
  }
  const regenerationResult = await input.pool.query<Record<string, unknown>>(
    `select id, plan_id, scope, week_starts_on, status, base_plan_version,
            error_code, created_at, updated_at, completed_at
       from monthly_campaign_regeneration_operations
      where campaign_id = $1 and project_id = $2
      order by created_at desc, id desc`,
    [campaign.id, projectId],
  );
  const operationIds = regenerationResult.rows.map((row) => Number(row.id));
  const regenerationTargets = operationIds.length
    ? await input.pool.query<{ operation_id: number | string; item_id: number | string }>(
      `select operation_id, item_id from monthly_campaign_regeneration_targets
        where project_id = $1 and operation_id = any($2::bigint[])
        order by operation_id, item_id`,
      [projectId, operationIds],
    )
    : { rows: [] };
  const targetIds = new Map<number, number[]>();
  for (const row of regenerationTargets.rows) {
    const operationId = Number(row.operation_id);
    const list = targetIds.get(operationId) ?? [];
    list.push(Number(row.item_id));
    targetIds.set(operationId, list);
  }
  return {
    campaign,
    plans: planResult.rows.map((row) => planFromRow(
      row,
      currentProfileHash,
      campaign,
      itemsByPlan.get(Number(row.id)) ?? [],
    )),
    regenerations: regenerationResult.rows.map((row) => ({
      id: Number(row.id),
      planId: Number(row.plan_id),
      scope: String(row.scope) as MonthlyCampaignRegenerationScope,
      weekStartsOn: row.week_starts_on == null ? null : dateOnly(row.week_starts_on),
      status: String(row.status) as MonthlyCampaignRegenerationRecord["status"],
      basePlanVersion: Number(row.base_plan_version),
      targetItemIds: targetIds.get(Number(row.id)) ?? [],
      errorCode: row.error_code == null ? null : String(row.error_code),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      completedAt: row.completed_at == null ? null : iso(row.completed_at),
    })),
  };
}

export async function createMonthlyCampaign(input: {
  pool: TransactionPool;
  actorUserId: number;
  brief: unknown;
  idempotencyKey: unknown;
  requestId?: string | null;
}): Promise<{ campaign: MonthlyCampaignSummary; duplicate: boolean }> {
  const brief = normalizeMonthlyCampaignBrief(input.brief);
  const requestKey = normalizeRequestKey(input.idempotencyKey);
  return withTransaction(input.pool, async (client) => {
    const projectId = await authorizeSelected(client, input.actorUserId, "content.create");
    ensureTimezone(await readProjectTimezone(client, projectId), brief.timezone);
    const profileHash = await readProjectContentProfileHash(client, projectId);
    const briefHash = monthlyCampaignBriefHash(brief);
    const requestHash = hashJson({ brief, profileHash });
    const replay = await client.query<Record<string, unknown>>(
      `${CAMPAIGN_SELECT} where project_id = $1 and request_key = $2 limit 1`,
      [projectId, requestKey],
    );
    if (replay.rows[0]) {
      const hash = await client.query<{ request_hash: string }>(
        `select request_hash from monthly_campaigns where id = $1 and project_id = $2`,
        [replay.rows[0].id, projectId],
      );
      if (hash.rows[0]?.request_hash !== requestHash) {
        throw new MonthlyCampaignServiceError("idempotency_conflict");
      }
      return { campaign: campaignFromRow(replay.rows[0]), duplicate: true };
    }
    const created = await client.query<Record<string, unknown>>(
      `insert into monthly_campaigns (
         project_id, created_by_user_id, updated_by_user_id, goal, starts_on, ends_on,
         timezone, rubrics, practice_mix, audience, funnel_stages, posts_per_week,
         important_dates, ctas, metrics, profile_version, content_brief_version,
         profile_hash, brief_hash, request_key, request_hash
       ) values (
         $1, $2, $2, $3, $4, $5, $6, $7::text[], $8::jsonb, $9, $10::text[], $11,
         $12::jsonb, $13::text[], $14::text[], $15, $16, $17, $18, $19, $20
       )
       returning id, project_id, goal, starts_on, ends_on, timezone, rubrics, practice_mix,
                 audience, funnel_stages, posts_per_week, important_dates, ctas, metrics,
                 profile_version, content_brief_version, profile_hash, brief_hash, version,
                 is_archived, created_at, updated_at`,
      [
        projectId, input.actorUserId, brief.goal, brief.startsOn, brief.endsOn, brief.timezone,
        brief.rubrics, JSON.stringify(brief.practiceMix), brief.audience, brief.funnelStages,
        brief.postsPerWeek, JSON.stringify(brief.importantDates), brief.ctas, brief.metrics,
        brief.profileVersion, brief.contentBriefVersion, profileHash, briefHash, requestKey, requestHash,
      ],
    );
    if (!created.rows[0]) throw new Error("monthly_campaign_creation_failed");
    await client.query(
      `insert into audit_events (
         project_id, actor_user_id, action, entity_type, entity_id,
         after_version, safe_data, request_id, idempotency_key
       ) values (
         $1, $2, 'monthly_campaign.created', 'monthly_campaign', $3::text,
         1, jsonb_build_object('brief_hash', $4::text, 'period_days', $5::int), $6, $7
       )`,
      [
        projectId, input.actorUserId, created.rows[0].id, briefHash,
        enumerateDates(brief.startsOn, brief.endsOn).length,
        input.requestId?.slice(0, 128) || null, `monthly-campaign:create:${requestKey}`,
      ],
    );
    return { campaign: campaignFromRow(created.rows[0]), duplicate: false };
  });
}

export async function updateMonthlyCampaign(input: {
  pool: TransactionPool;
  actorUserId: number;
  campaignId: number;
  expectedVersion: unknown;
  brief: unknown;
  requestId?: string | null;
}): Promise<MonthlyCampaignSummary> {
  const brief = normalizeMonthlyCampaignBrief(input.brief);
  const expectedVersion = positiveVersion(input.expectedVersion);
  return withTransaction(input.pool, async (client) => {
    const projectId = await authorizeSelected(client, input.actorUserId, "content.edit");
    ensureTimezone(await readProjectTimezone(client, projectId), brief.timezone);
    const current = await client.query<Record<string, unknown>>(
      `${CAMPAIGN_SELECT} where id = $1 and project_id = $2 for update`,
      [positiveId(input.campaignId), projectId],
    );
    if (!current.rows[0]) throw new MonthlyCampaignServiceError("not_found");
    const previous = campaignFromRow(current.rows[0]);
    if (previous.archived) throw new MonthlyCampaignServiceError("archived");
    if (previous.version !== expectedVersion) throw new MonthlyCampaignServiceError("version_conflict");
    const profileHash = await readProjectContentProfileHash(client, projectId);
    const briefHash = monthlyCampaignBriefHash(brief);
    const updated = await client.query<Record<string, unknown>>(
      `update monthly_campaigns
          set updated_by_user_id = $3, goal = $4, starts_on = $5, ends_on = $6,
              timezone = $7, rubrics = $8::text[], practice_mix = $9::jsonb,
              audience = $10, funnel_stages = $11::text[], posts_per_week = $12,
              important_dates = $13::jsonb, ctas = $14::text[], metrics = $15::text[],
              profile_version = $16, content_brief_version = $17, profile_hash = $18,
              brief_hash = $19, version = version + 1, updated_at = now()
        where id = $1 and project_id = $2 and version = $20
        returning id, project_id, goal, starts_on, ends_on, timezone, rubrics, practice_mix,
                  audience, funnel_stages, posts_per_week, important_dates, ctas, metrics,
                  profile_version, content_brief_version, profile_hash, brief_hash, version,
                  is_archived, created_at, updated_at`,
      [
        previous.id, projectId, input.actorUserId, brief.goal, brief.startsOn, brief.endsOn,
        brief.timezone, brief.rubrics, JSON.stringify(brief.practiceMix), brief.audience,
        brief.funnelStages, brief.postsPerWeek, JSON.stringify(brief.importantDates), brief.ctas,
        brief.metrics, brief.profileVersion, brief.contentBriefVersion, profileHash, briefHash,
        expectedVersion,
      ],
    );
    if (!updated.rows[0]) throw new MonthlyCampaignServiceError("version_conflict");
    const next = campaignFromRow(updated.rows[0]);
    await client.query(
      `insert into audit_events (
         project_id, actor_user_id, action, entity_type, entity_id,
         before_version, after_version, safe_data, request_id
       ) values (
         $1, $2, 'monthly_campaign.updated', 'monthly_campaign', $3::text,
         $4, $5, jsonb_build_object('before_hash', $6::text, 'after_hash', $7::text), $8
       )`,
      [projectId, input.actorUserId, previous.id, previous.version, next.version,
        previous.briefHash, next.briefHash, input.requestId?.slice(0, 128) || null],
    );
    return next;
  });
}

export function normalizeMonthlyCampaignItems(
  value: unknown,
  campaign: Pick<MonthlyCampaignSummary, "startsOn" | "endsOn" | "rubrics" | "practiceMix" | "funnelStages">,
): NormalizedMonthlyCampaignItem[] {
  const dates = enumerateDates(campaign.startsOn, campaign.endsOn);
  if (!Array.isArray(value) || value.length !== dates.length) {
    throw new MonthlyCampaignServiceError("invalid_items");
  }
  const rubricSet = new Set(campaign.rubrics);
  const practiceSet = new Set(campaign.practiceMix.map((item) => item.name));
  const funnelSet = new Set(campaign.funnelStages);
  const items = value.map((candidate) => {
    const item = asObject(candidate);
    if (!item || !hasExactKeys(item, [
      "itemKey", "scheduledFor", "position", "title", "rubric", "practice", "funnelStage", "state",
    ])) throw new MonthlyCampaignServiceError("invalid_item");
    const scheduledFor = parseDateOnly(item.scheduledFor);
    if (!scheduledFor || scheduledFor < campaign.startsOn || scheduledFor > campaign.endsOn) {
      throw new MonthlyCampaignServiceError("invalid_item");
    }
    if (typeof item.position !== "number" || !Number.isInteger(item.position)
        || item.position < 0 || item.position >= dates.length) {
      throw new MonthlyCampaignServiceError("invalid_item");
    }
    const rubric = cleanText(item.rubric, 120, "invalid_item");
    const practice = cleanText(item.practice, 160, "invalid_item");
    if (!rubricSet.has(rubric) || !practiceSet.has(practice)
        || typeof item.funnelStage !== "string" || !funnelSet.has(item.funnelStage as MonthlyCampaignFunnelStage)) {
      throw new MonthlyCampaignServiceError("invalid_item");
    }
    if (item.state !== "topic" && item.state !== "detailed") {
      throw new MonthlyCampaignServiceError("invalid_item");
    }
    return {
      itemKey: cleanText(item.itemKey, 128, "invalid_item"),
      scheduledFor,
      position: item.position,
      title: cleanText(item.title, 240, "invalid_item"),
      rubric,
      practice,
      funnelStage: item.funnelStage as MonthlyCampaignFunnelStage,
      state: item.state as MonthlyCampaignItemState,
    };
  });
  if (new Set(items.map((item) => item.itemKey)).size !== items.length
      || new Set(items.map((item) => item.scheduledFor)).size !== items.length
      || new Set(items.map((item) => item.position)).size !== items.length) {
    throw new MonthlyCampaignServiceError("invalid_items");
  }
  const sortedDates = items.map((item) => item.scheduledFor).sort();
  const sortedPositions = items.map((item) => item.position).sort((a, b) => a - b);
  if (sortedDates.some((date, index) => date !== dates[index])
      || sortedPositions.some((position, index) => position !== index)) {
    throw new MonthlyCampaignServiceError("invalid_items");
  }
  const firstWeekEnd = dates[Math.min(6, dates.length - 1)];
  if (items.some((item) => item.state === "detailed" && item.scheduledFor > firstWeekEnd)) {
    throw new MonthlyCampaignServiceError("invalid_items");
  }
  return items.sort((left, right) => left.scheduledFor.localeCompare(right.scheduledFor) || left.position - right.position);
}

export function assertNoDuplicateCampaignTopics(
  items: readonly Pick<NormalizedMonthlyCampaignItem, "itemKey" | "title">[],
  candidates: readonly { id: string; title: string }[] = [],
  threshold = 0.82,
): void {
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      if (titleSimilarity(items[left].title, items[right].title) >= threshold) {
        throw new MonthlyCampaignServiceError("duplicate_topics");
      }
    }
    if (candidates.some((candidate) => titleSimilarity(items[left].title, candidate.title) >= threshold)) {
      throw new MonthlyCampaignServiceError("duplicate_topics");
    }
  }
}

export async function createMonthlyCampaignPlan(input: {
  pool: TransactionPool;
  actorUserId: number;
  campaignId: number;
  expectedCampaignVersion: unknown;
  items: unknown;
  idempotencyKey: unknown;
  requestId?: string | null;
}): Promise<{ plan: MonthlyCampaignPlanRecord; duplicate: boolean }> {
  const expectedCampaignVersion = positiveVersion(input.expectedCampaignVersion);
  const requestKey = normalizeRequestKey(input.idempotencyKey);
  return withTransaction(input.pool, async (client) => {
    const projectId = await authorizeSelected(client, input.actorUserId, "content.create");
    const campaignResult = await client.query<Record<string, unknown>>(
      `${CAMPAIGN_SELECT} where id = $1 and project_id = $2 for update`,
      [positiveId(input.campaignId), projectId],
    );
    if (!campaignResult.rows[0]) throw new MonthlyCampaignServiceError("not_found");
    const campaign = campaignFromRow(campaignResult.rows[0]);
    if (campaign.archived) throw new MonthlyCampaignServiceError("archived");
    const items = normalizeMonthlyCampaignItems(input.items, campaign);
    const duplicateCandidates = await client.query<{ id: string; title: string }>(
      `select candidate.id, candidate.title
         from (
           select 'past_plan:' || item.id::text as id, item.title::text as title,
                  item.updated_at as found_at
             from monthly_campaign_items item
             join monthly_campaign_plans plan on plan.id = item.plan_id and plan.project_id = item.project_id
            where item.project_id = $1 and plan.campaign_id <> $2
           union all
           select 'library:' || saved.id::text as id,
                  coalesce(nullif(btrim(saved.source_title), ''), left(saved.text, 240)) as title,
                  saved.created_at as found_at
             from saved_posts saved
             join channels channel on channel.id = saved.channel_id
            where channel.project_id = $1
         ) candidate
        where length(btrim(candidate.title)) > 0
        order by candidate.found_at desc
        limit 4000`,
      [projectId, campaign.id],
    );
    assertNoDuplicateCampaignTopics(items, duplicateCandidates.rows);
    const currentProfileHash = await readProjectContentProfileHash(client, projectId);
    const requestHash = hashJson({ items, briefHash: campaign.briefHash, profileHash: currentProfileHash });
    const replay = await client.query<Record<string, unknown>>(
      `${PLAN_SELECT} where campaign_id = $1 and project_id = $2 and request_key = $3 limit 1`,
      [campaign.id, projectId, requestKey],
    );
    if (replay.rows[0]) {
      const hash = await client.query<{ request_hash: string }>(
        `select request_hash from monthly_campaign_plans where id = $1 and project_id = $2`,
        [replay.rows[0].id, projectId],
      );
      if (hash.rows[0]?.request_hash !== requestHash) throw new MonthlyCampaignServiceError("idempotency_conflict");
      const storedItems = await client.query<Record<string, unknown>>(
        `${ITEM_SELECT} where plan_id = $1 and project_id = $2 order by scheduled_for, position, id`,
        [replay.rows[0].id, projectId],
      );
      return {
        plan: planFromRow(replay.rows[0], currentProfileHash, campaign, storedItems.rows.map(itemFromRow)),
        duplicate: true,
      };
    }
    if (campaign.version !== expectedCampaignVersion) throw new MonthlyCampaignServiceError("version_conflict");
    if (campaign.profileHash !== currentProfileHash) throw new MonthlyCampaignServiceError("stale_campaign");
    const revision = Number((await client.query<{ next_revision: number | string }>(
      `select coalesce(max(revision), 0) + 1 as next_revision
         from monthly_campaign_plans where campaign_id = $1 and project_id = $2`,
      [campaign.id, projectId],
    )).rows[0]?.next_revision ?? 1);
    const created = await client.query<Record<string, unknown>>(
      `insert into monthly_campaign_plans (
         project_id, campaign_id, revision, source_campaign_version, source_brief_hash,
         source_profile_hash, source_profile_version, source_content_brief_version,
         request_key, request_hash, created_by_user_id
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning id, project_id, campaign_id, revision, status, source_campaign_version,
                 source_brief_hash, source_profile_hash, source_profile_version,
                 source_content_brief_version, version, submitted_at, approved_at,
                 created_at, updated_at`,
      [projectId, campaign.id, revision, campaign.version, campaign.briefHash, currentProfileHash,
        campaign.profileVersion, campaign.contentBriefVersion, requestKey, requestHash, input.actorUserId],
    );
    if (!created.rows[0]) throw new Error("monthly_campaign_plan_creation_failed");
    const planId = Number(created.rows[0].id);
    const insertedItems = await client.query<Record<string, unknown>>(
      `insert into monthly_campaign_items (
         project_id, plan_id, item_key, scheduled_for, position, title, rubric,
         practice, funnel_stage, state
       )
       select $1, $2, item.item_key, item.scheduled_for::date, item.position,
              item.title, item.rubric, item.practice, item.funnel_stage, item.state
         from jsonb_to_recordset($3::jsonb) as item(
           item_key text, scheduled_for text, position integer, title text,
           rubric text, practice text, funnel_stage text, state text
         )
       returning id, project_id, plan_id, item_key, scheduled_for, position, title, rubric,
                 practice, funnel_stage, state, approval_status, content_version,
                 approved_content_version, source_item_id, weekly_autopilot_plan_id,
                 weekly_autopilot_item_index, draft_id, post_id, latest_post_stats_id,
                 regeneration_version, regeneration_status, created_at, updated_at`,
      [projectId, planId, JSON.stringify(items.map((item) => ({
        item_key: item.itemKey,
        scheduled_for: item.scheduledFor,
        position: item.position,
        title: item.title,
        rubric: item.rubric,
        practice: item.practice,
        funnel_stage: item.funnelStage,
        state: item.state,
      })))],
    );
    if (insertedItems.rows.length !== items.length) throw new Error("monthly_campaign_items_creation_failed");
    await client.query(
      `insert into audit_events (
         project_id, actor_user_id, action, entity_type, entity_id,
         after_version, safe_data, request_id, idempotency_key
       ) values (
         $1, $2, 'monthly_campaign.plan_created', 'monthly_campaign_plan', $3::text,
         1, jsonb_build_object('campaign_id', $4::bigint, 'revision', $5::bigint,
              'item_count', $6::int, 'brief_hash', $7::text), $8, $9
       )`,
      [projectId, input.actorUserId, planId, campaign.id, revision, items.length,
        campaign.briefHash, input.requestId?.slice(0, 128) || null,
        `monthly-campaign:plan:${campaign.id}:${requestKey}`],
    );
    return {
      plan: planFromRow(created.rows[0], currentProfileHash, campaign, insertedItems.rows.map(itemFromRow)),
      duplicate: false,
    };
  });
}

async function lockedPlanContext(
  client: PoolClient,
  projectId: number,
  campaignId: number,
  planId: number,
): Promise<{ campaign: MonthlyCampaignSummary; planRow: Record<string, unknown> }> {
  const campaignResult = await client.query<Record<string, unknown>>(
    `${CAMPAIGN_SELECT} where id = $1 and project_id = $2 limit 1`,
    [campaignId, projectId],
  );
  if (!campaignResult.rows[0]) throw new MonthlyCampaignServiceError("not_found");
  const planResult = await client.query<Record<string, unknown>>(
    `${PLAN_SELECT} where id = $1 and campaign_id = $2 and project_id = $3 for update`,
    [planId, campaignId, projectId],
  );
  if (!planResult.rows[0]) throw new MonthlyCampaignServiceError("not_found");
  return { campaign: campaignFromRow(campaignResult.rows[0]), planRow: planResult.rows[0] };
}

async function ensureNoActivePlanRegeneration(
  client: Pick<PoolClient, "query">,
  projectId: number,
  planId: number,
): Promise<void> {
  const active = await client.query<{ id: number | string }>(
    `select id
       from monthly_campaign_regeneration_operations
      where project_id = $1 and plan_id = $2
        and status in ('pending', 'processing', 'retryable_failed')
      order by id desc
      limit 1`,
    [projectId, planId],
  );
  if (active.rows[0]) throw new MonthlyCampaignServiceError("regeneration_in_progress");
}

export async function transitionMonthlyCampaignPlan(input: {
  pool: TransactionPool;
  actorUserId: number;
  campaignId: number;
  planId: number;
  expectedPlanVersion: unknown;
  action: unknown;
  requestId?: string | null;
}): Promise<{ id: number; status: MonthlyCampaignPlanStatus; version: number }> {
  if (input.action !== "submit" && input.action !== "approve") {
    throw new MonthlyCampaignServiceError("invalid_transition");
  }
  const expectedPlanVersion = positiveVersion(input.expectedPlanVersion);
  const permission: ProjectPermission = input.action === "submit" ? "content.submit" : "content.approve";
  return withTransaction(input.pool, async (client) => {
    const projectId = await authorizeSelected(client, input.actorUserId, permission);
    const { campaign, planRow } = await lockedPlanContext(
      client, projectId, positiveId(input.campaignId), positiveId(input.planId),
    );
    await ensureNoActivePlanRegeneration(client, projectId, Number(planRow.id));
    if (Number(planRow.version) !== expectedPlanVersion) {
      throw new MonthlyCampaignServiceError("version_conflict");
    }
    const currentProfileHash = await readProjectContentProfileHash(client, projectId);
    ensureCampaignFresh(campaign, planRow, currentProfileHash);
    const currentStatus = String(planRow.status) as MonthlyCampaignPlanStatus;
    const expectedStatus = input.action === "submit" ? "draft" : "in_review";
    if (currentStatus !== expectedStatus) throw new MonthlyCampaignServiceError("invalid_transition");
    const nextStatus: MonthlyCampaignPlanStatus = input.action === "submit" ? "in_review" : "approved";
    const updated = await client.query<{ id: number | string; status: string; version: number | string }>(
      `update monthly_campaign_plans
          set status = $4,
              submitted_by_user_id = case when $4 = 'in_review' then $5 else submitted_by_user_id end,
              submitted_at = case when $4 = 'in_review' then now() else submitted_at end,
              approved_by_user_id = case when $4 = 'approved' then $5 else null end,
              approved_at = case when $4 = 'approved' then now() else null end,
              version = version + 1, updated_at = now()
        where id = $1 and campaign_id = $2 and project_id = $3 and version = $6
        returning id, status, version`,
      [planRow.id, campaign.id, projectId, nextStatus, input.actorUserId, expectedPlanVersion],
    );
    if (!updated.rows[0]) throw new MonthlyCampaignServiceError("version_conflict");
    await client.query(
      `update monthly_campaign_items
          set approval_status = $3,
              approved_content_version = case when $3 = 'approved' then content_version else null end,
              updated_at = now()
        where plan_id = $1 and project_id = $2`,
      [planRow.id, projectId, nextStatus],
    );
    const next = updated.rows[0];
    await client.query(
      `insert into audit_events (
         project_id, actor_user_id, action, entity_type, entity_id,
         before_version, after_version, safe_data, request_id
       ) values (
         $1, $2, $3, 'monthly_campaign_plan', $4::text, $5, $6,
         jsonb_build_object('campaign_id', $7::bigint, 'from_status', $8::text,
              'to_status', $9::text, 'brief_hash', $10::text), $11
       )`,
      [projectId, input.actorUserId,
        input.action === "submit" ? "monthly_campaign.plan_submitted" : "monthly_campaign.plan_approved",
        planRow.id,
        expectedPlanVersion, Number(next.version), campaign.id, currentStatus, nextStatus,
        campaign.briefHash, input.requestId?.slice(0, 128) || null],
    );
    return { id: Number(next.id), status: next.status as MonthlyCampaignPlanStatus, version: Number(next.version) };
  });
}

export async function moveMonthlyCampaignItem(input: {
  pool: TransactionPool;
  actorUserId: number;
  campaignId: number;
  planId: number;
  itemId: number;
  targetDate: unknown;
  targetPosition: unknown;
  expectedPlanVersion: unknown;
  requestId?: string | null;
}): Promise<{ planVersion: number; items: MonthlyCampaignItemRecord[] }> {
  if (!Number.isSafeInteger(input.itemId) || input.itemId < 1) {
    throw new MonthlyCampaignServiceError("invalid_move");
  }
  const targetDate = parseDateOnly(input.targetDate);
  if (!targetDate || typeof input.targetPosition !== "number" || !Number.isInteger(input.targetPosition)) {
    throw new MonthlyCampaignServiceError("invalid_move");
  }
  const expectedPlanVersion = positiveVersion(input.expectedPlanVersion);
  return withTransaction(input.pool, async (client) => {
    const projectId = await authorizeSelected(client, input.actorUserId, "content.edit");
    const { campaign, planRow } = await lockedPlanContext(
      client, projectId, positiveId(input.campaignId), positiveId(input.planId),
    );
    await ensureNoActivePlanRegeneration(client, projectId, Number(planRow.id));
    if (Number(planRow.version) !== expectedPlanVersion) throw new MonthlyCampaignServiceError("version_conflict");
    if (targetDate < campaign.startsOn || targetDate > campaign.endsOn) {
      throw new MonthlyCampaignServiceError("invalid_move");
    }
    const rows = await client.query<Record<string, unknown>>(
      `${ITEM_SELECT} where plan_id = $1 and project_id = $2 order by scheduled_for, position, id for update`,
      [planRow.id, projectId],
    );
    const current = rows.rows.find((row) => Number(row.id) === positiveId(input.itemId, "invalid_move"));
    const target = rows.rows.find((row) => dateOnly(row.scheduled_for) === targetDate
      && Number(row.position) === input.targetPosition);
    if (!current || !target) throw new MonthlyCampaignServiceError("invalid_move");
    if (current.id === target.id) {
      return { planVersion: expectedPlanVersion, items: rows.rows.map(itemFromRow) };
    }
    await client.query(
      `set constraints monthly_campaign_items_plan_date_uniq,
                       monthly_campaign_items_plan_position_uniq deferred`,
    );
    await client.query(
      `update monthly_campaign_items
          set scheduled_for = case when id = $3 then $6::date else $5::date end,
              position = case when id = $3 then $8::integer else $7::integer end,
              updated_at = now()
        where plan_id = $1 and project_id = $2 and id in ($3, $4)`,
      [planRow.id, projectId, current.id, target.id, dateOnly(current.scheduled_for),
        dateOnly(target.scheduled_for), Number(current.position), Number(target.position)],
    );
    const versionResult = await client.query<{ version: number | string }>(
      `update monthly_campaign_plans set version = version + 1, updated_at = now()
        where id = $1 and project_id = $2 and version = $3 returning version`,
      [planRow.id, projectId, expectedPlanVersion],
    );
    if (!versionResult.rows[0]) throw new MonthlyCampaignServiceError("version_conflict");
    await client.query(
      `insert into audit_events (
         project_id, actor_user_id, action, entity_type, entity_id,
         before_version, after_version, safe_data, request_id
       ) values (
         $1, $2, 'monthly_campaign.item_moved', 'monthly_campaign_item', $3::text,
         $4, $5, jsonb_build_object('plan_id', $6::bigint, 'from_date', $7::date,
              'to_date', $8::date, 'from_position', $9::int, 'to_position', $10::int), $11
       )`,
      [projectId, input.actorUserId, current.id, expectedPlanVersion,
        Number(versionResult.rows[0].version), planRow.id, dateOnly(current.scheduled_for),
        dateOnly(target.scheduled_for), Number(current.position), Number(target.position),
        input.requestId?.slice(0, 128) || null],
    );
    const updatedRows = await client.query<Record<string, unknown>>(
      `${ITEM_SELECT} where plan_id = $1 and project_id = $2 order by scheduled_for, position, id`,
      [planRow.id, projectId],
    );
    return { planVersion: Number(versionResult.rows[0].version), items: updatedRows.rows.map(itemFromRow) };
  });
}

export async function requestMonthlyCampaignRegeneration(input: {
  pool: TransactionPool;
  actorUserId: number;
  campaignId: number;
  planId: number;
  expectedPlanVersion: unknown;
  scope: unknown;
  itemId?: unknown;
  weekStartsOn?: unknown;
  idempotencyKey: unknown;
  requestId?: string | null;
}): Promise<{
  operationId: number;
  status: "pending" | "processing" | "completed" | "stale" | "retryable_failed" | "failed" | "cancelled";
  duplicate: boolean;
  planVersion: number;
  targetItemIds: number[];
}> {
  if (input.scope !== "item" && input.scope !== "week") {
    throw new MonthlyCampaignServiceError("invalid_regeneration_scope");
  }
  const scope = input.scope;
  if (scope === "item" && (typeof input.itemId !== "number"
      || !Number.isSafeInteger(input.itemId) || input.itemId < 1)) {
    throw new MonthlyCampaignServiceError("invalid_regeneration_scope");
  }
  const itemId = scope === "item" ? input.itemId as number : null;
  const weekStartsOn = scope === "week" ? parseDateOnly(input.weekStartsOn) : null;
  if (scope === "week" && !weekStartsOn) throw new MonthlyCampaignServiceError("invalid_regeneration_scope");
  const expectedPlanVersion = positiveVersion(input.expectedPlanVersion);
  const requestKey = normalizeRequestKey(input.idempotencyKey);
  const requestHash = hashJson({ scope, itemId, weekStartsOn, expectedPlanVersion });
  return withTransaction(input.pool, async (client) => {
    const projectId = await authorizeSelected(client, input.actorUserId, "content.edit");
    const { campaign, planRow } = await lockedPlanContext(
      client, projectId, positiveId(input.campaignId), positiveId(input.planId),
    );
    const replay = await client.query<{
      id: number | string; request_hash: string; status: string; base_plan_version: number | string;
    }>(
      `select id, request_hash, status, base_plan_version
         from monthly_campaign_regeneration_operations
        where project_id = $1 and request_key = $2 limit 1`,
      [projectId, requestKey],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].request_hash !== requestHash) {
        throw new MonthlyCampaignServiceError("idempotency_conflict");
      }
      const targets = await client.query<{ item_id: number | string }>(
        `select item_id from monthly_campaign_regeneration_targets
          where operation_id = $1 and project_id = $2 order by item_id`,
        [replay.rows[0].id, projectId],
      );
      return {
        operationId: Number(replay.rows[0].id),
        status: replay.rows[0].status as "pending",
        duplicate: true,
        planVersion: Number(replay.rows[0].base_plan_version) + 1,
        targetItemIds: targets.rows.map((row) => Number(row.item_id)),
      };
    }
    if (Number(planRow.version) !== expectedPlanVersion) throw new MonthlyCampaignServiceError("version_conflict");
    const currentProfileHash = await readProjectContentProfileHash(client, projectId);
    ensureCampaignFresh(campaign, planRow, currentProfileHash);
    const targetResult = scope === "item"
      ? await client.query<Record<string, unknown>>(
        `${ITEM_SELECT} where id = $1 and plan_id = $2 and project_id = $3 for update`,
        [itemId, planRow.id, projectId],
      )
      : await client.query<Record<string, unknown>>(
        `${ITEM_SELECT}
          where plan_id = $1 and project_id = $2
            and scheduled_for >= $3::date and scheduled_for < $3::date + 7
          order by scheduled_for, position, id for update`,
        [planRow.id, projectId, weekStartsOn],
      );
    if (!targetResult.rows.length) throw new MonthlyCampaignServiceError("no_regeneration_targets");
    const operation = await client.query<{ id: number | string; status: string }>(
      `insert into monthly_campaign_regeneration_operations (
         project_id, campaign_id, plan_id, requested_by_user_id, scope, week_starts_on,
         request_key, request_hash, base_plan_version, base_brief_hash, base_profile_hash
       ) values ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, $11)
       returning id, status`,
      [projectId, campaign.id, planRow.id, input.actorUserId, scope, weekStartsOn,
        requestKey, requestHash, expectedPlanVersion, campaign.briefHash, currentProfileHash],
    );
    if (!operation.rows[0]) throw new Error("monthly_campaign_regeneration_creation_failed");
    const operationId = Number(operation.rows[0].id);
    const targetIds = targetResult.rows.map((row) => Number(row.id));
    await client.query(
      `insert into monthly_campaign_regeneration_targets (
         operation_id, project_id, item_id, item_content_version, item_regeneration_version
       )
       select $1, $2, target.id, target.content_version, target.regeneration_version + 1
         from monthly_campaign_items target
        where target.project_id = $2 and target.plan_id = $3 and target.id = any($4::bigint[])`,
      [operationId, projectId, planRow.id, targetIds],
    );
    await client.query(
      `update monthly_campaign_items
          set regeneration_status = 'pending', regeneration_version = regeneration_version + 1,
              updated_at = now()
        where project_id = $1 and plan_id = $2 and id = any($3::bigint[])`,
      [projectId, planRow.id, targetIds],
    );
    const versionResult = await client.query<{ version: number | string }>(
      `update monthly_campaign_plans set version = version + 1, updated_at = now()
        where id = $1 and project_id = $2 and version = $3 returning version`,
      [planRow.id, projectId, expectedPlanVersion],
    );
    if (!versionResult.rows[0]) throw new MonthlyCampaignServiceError("version_conflict");
    await client.query(
      `insert into monthly_campaign_regeneration_outbox (operation_id, project_id)
       values ($1, $2)`,
      [operationId, projectId],
    );
    await client.query(
      `insert into audit_events (
         project_id, actor_user_id, action, entity_type, entity_id,
         before_version, after_version, safe_data, request_id, idempotency_key
       ) values (
         $1, $2, 'monthly_campaign.regeneration_requested', 'monthly_campaign_plan', $3::text,
         $4, $5, jsonb_build_object('operation_id', $6::bigint, 'scope', $7::text,
              'target_count', $8::int, 'brief_hash', $9::text), $10, $11
       )`,
      [projectId, input.actorUserId, planRow.id, expectedPlanVersion,
        Number(versionResult.rows[0].version), operationId, scope, targetIds.length,
        campaign.briefHash, input.requestId?.slice(0, 128) || null,
        `monthly-campaign:regenerate:${requestKey}`],
    );
    return {
      operationId,
      status: operation.rows[0].status as "pending",
      duplicate: false,
      planVersion: Number(versionResult.rows[0].version),
      targetItemIds: targetIds,
    };
  });
}

export async function linkMonthlyCampaignItem(input: {
  pool: TransactionPool;
  actorUserId: number;
  campaignId: number;
  planId: number;
  itemId: number;
  expectedPlanVersion: unknown;
  weeklyAutopilotPlanId?: unknown;
  weeklyAutopilotItemIndex?: unknown;
  draftId?: unknown;
  postId?: unknown;
  latestPostStatsId?: unknown;
  requestId?: string | null;
}): Promise<{ planVersion: number; item: MonthlyCampaignItemRecord }> {
  const expectedPlanVersion = positiveVersion(input.expectedPlanVersion);
  const optionalId = (value: unknown) => {
    if (value == null) return null;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      throw new MonthlyCampaignServiceError("lineage_conflict");
    }
    return value;
  };
  const weeklyAutopilotPlanId = optionalId(input.weeklyAutopilotPlanId);
  const draftId = optionalId(input.draftId);
  const postId = optionalId(input.postId);
  const latestPostStatsId = optionalId(input.latestPostStatsId);
  const weeklyAutopilotItemIndex = input.weeklyAutopilotItemIndex == null
    ? null
    : typeof input.weeklyAutopilotItemIndex === "number"
      && Number.isInteger(input.weeklyAutopilotItemIndex) && input.weeklyAutopilotItemIndex >= 0
      ? input.weeklyAutopilotItemIndex
      : (() => { throw new MonthlyCampaignServiceError("lineage_conflict"); })();
  if ((weeklyAutopilotPlanId == null) !== (weeklyAutopilotItemIndex == null)) {
    throw new MonthlyCampaignServiceError("lineage_conflict");
  }
  if (latestPostStatsId != null && postId == null) throw new MonthlyCampaignServiceError("lineage_conflict");
  return withTransaction(input.pool, async (client) => {
    const projectId = await authorizeSelected(client, input.actorUserId, "content.edit");
    const { planRow } = await lockedPlanContext(
      client, projectId, positiveId(input.campaignId), positiveId(input.planId),
    );
    if (Number(planRow.version) !== expectedPlanVersion) throw new MonthlyCampaignServiceError("version_conflict");
    const item = await client.query<Record<string, unknown>>(
      `${ITEM_SELECT} where id = $1 and plan_id = $2 and project_id = $3 for update`,
      [positiveId(input.itemId, "lineage_conflict"), planRow.id, projectId],
    );
    if (!item.rows[0]) throw new MonthlyCampaignServiceError("not_found");
    const valid = await client.query<{ valid: boolean }>(
      `select
         ($2::bigint is null or exists (
           select 1 from autopilot_plan weekly where weekly.id = $2 and weekly.project_id = $1
         ))
         and ($3::bigint is null or exists (
           select 1 from drafts draft where draft.id = $3 and draft.project_id = $1
         ))
         and ($4::bigint is null or exists (
           select 1 from posts post where post.id = $4 and post.project_id = $1
         ))
         and ($5::bigint is null or exists (
           select 1 from post_stats snapshot
            where snapshot.id = $5 and snapshot.post_id = $4 and snapshot.project_id = $1
         )) as valid`,
      [projectId, weeklyAutopilotPlanId, draftId, postId, latestPostStatsId],
    );
    if (valid.rows[0]?.valid !== true) throw new MonthlyCampaignServiceError("lineage_conflict");
    const updated = await client.query<Record<string, unknown>>(
      `update monthly_campaign_items
          set weekly_autopilot_plan_id = $4, weekly_autopilot_item_index = $5,
              draft_id = $6, post_id = $7, latest_post_stats_id = $8, updated_at = now()
        where id = $1 and plan_id = $2 and project_id = $3
        returning id, project_id, plan_id, item_key, scheduled_for, position, title, rubric,
                  practice, funnel_stage, state, approval_status, content_version,
                  approved_content_version, source_item_id, weekly_autopilot_plan_id,
                  weekly_autopilot_item_index, draft_id, post_id, latest_post_stats_id,
                  regeneration_version, regeneration_status, created_at, updated_at`,
      [item.rows[0].id, planRow.id, projectId, weeklyAutopilotPlanId,
        weeklyAutopilotItemIndex, draftId, postId, latestPostStatsId],
    );
    const version = await client.query<{ version: number | string }>(
      `update monthly_campaign_plans set version = version + 1, updated_at = now()
        where id = $1 and project_id = $2 and version = $3 returning version`,
      [planRow.id, projectId, expectedPlanVersion],
    );
    if (!updated.rows[0] || !version.rows[0]) throw new MonthlyCampaignServiceError("version_conflict");
    await client.query(
      `insert into audit_events (
         project_id, actor_user_id, action, entity_type, entity_id,
         before_version, after_version, safe_data, request_id
       ) values (
         $1, $2, 'monthly_campaign.item_linked', 'monthly_campaign_item', $3::text,
         $4, $5, jsonb_build_object('plan_id', $6::bigint,
              'weekly_linked', $7::boolean, 'draft_linked', $8::boolean,
              'post_linked', $9::boolean, 'analytics_linked', $10::boolean), $11
       )`,
      [projectId, input.actorUserId, item.rows[0].id, expectedPlanVersion,
        Number(version.rows[0].version), planRow.id, weeklyAutopilotPlanId != null,
        draftId != null, postId != null, latestPostStatsId != null,
        input.requestId?.slice(0, 128) || null],
    );
    return { planVersion: Number(version.rows[0].version), item: itemFromRow(updated.rows[0]) };
  });
}
