import type { Pool, PoolClient } from "pg";

import { getPool } from "./db";
import { ensureGrowthBoard } from "./growth";
import {
  OPPORTUNITY_FORMULA_VERSION,
  baselineCoverage,
  materializeOpportunitySnapshots,
  normalizeTopicKey,
  opportunityConfidence,
  opportunityExpiry,
  opportunityFingerprint,
} from "./opportunity-snapshot-materializer.mjs";
import { requireSelectedProjectPermission } from "./project-permissions";
import { createDraftForUser } from "./server-drafts";
import { syncPublicMarketSignals } from "./opportunity-market.mjs";

type Queryable = Pick<Pool | PoolClient, "query">;

export const RELEASE_1_FEATURE = "content_intelligence_release_1" as const;
export const TODAY_RANKING_VERSION = "today-rank-v1" as const;
export {
  OPPORTUNITY_FORMULA_VERSION,
  baselineCoverage,
  normalizeTopicKey,
  opportunityConfidence,
  opportunityExpiry,
  opportunityFingerprint,
};

export type Confidence = "low" | "medium" | "high";
export type EpistemicState = "observed" | "inferred" | "insufficient_data" | "stale";

export type OpportunitySnapshot = {
  id: number;
  projectId: number;
  channelId: number;
  channelLabel: string;
  revision: number;
  title: string;
  angle: string;
  confidence: Confidence;
  epistemicState: EpistemicState;
  formulaVersion: string;
  observedAt: string | null;
  expiresAt: string;
  freshnessLabel: string;
  sampleSize: number | null;
  demand: number;
  coverage: number;
  saturation: number;
  sourceLabel: string | null;
  sourceType: string;
  methodology: string;
  sourceContextDraftId: number | null;
  actionable: boolean;
  actionHref?: string;
  opportunityType: "breaking_news" | "rising_topic" | "evergreen_gap" | "competitor_gap" | "audience_need" | "offer_gap";
  priorityScore: number;
  publishBefore: string | null;
  sourceCount: number;
  sources: Array<{ url: string; label: string | null; trust: number | null }>;
  whyNow: string | null;
  formatSuggestion: string | null;
  userState: "saved" | "used" | null;
};

export type OpportunityMapContext = {
  profileReady: boolean;
  researchState: "ready" | "profile_required" | "researching";
  lastRefreshAt: string | null;
};

export class ContentIntelligenceError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ContentIntelligenceError";
  }
}

function safeId(value: unknown): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function freshness(expiresAt: string, observedAt: string | null, now = new Date()): string {
  if (new Date(expiresAt).getTime() <= now.getTime()) return "Сигнал устарел";
  if (!observedAt) return "Дата источника неизвестна";
  const hours = Math.max(0, Math.floor((now.getTime() - new Date(observedAt).getTime()) / 3_600_000));
  if (hours < 1) return "Обновлено меньше часа назад";
  if (hours < 24) return `Обновлено ${hours} ч назад`;
  const days = Math.floor(hours / 24);
  return `Обновлено ${days} ${days === 1 ? "день" : days < 5 ? "дня" : "дней"} назад`;
}

async function resolveChannelScope(db: Queryable, actorUserId: number, requestedChannelId: number | null) {
  const membership = await requireSelectedProjectPermission(db, actorUserId, "project.read");
  const row = (await db.query<{ id: string; title: string | null; handle: string | null }>(
    `select id, title, handle from channels
      where project_id = $1 and is_active = true and status = 'active'
        and ($2::bigint is null or id = $2)
      order by id limit 1`,
    [membership.projectId, requestedChannelId],
  )).rows[0];
  if (!row) throw new ContentIntelligenceError("channel_not_found");
  return {
    projectId: membership.projectId,
    channelId: Number(row.id),
    channelLabel: row.title?.trim() || (row.handle ? `@${row.handle.replace(/^@/u, "")}` : "Канал"),
  };
}

export async function release1Enabled(
  db: Queryable,
  scope: { projectId: number; channelId: number },
): Promise<boolean> {
  if (process.env.NODE_ENV !== "production" && process.env.AURORA_RELEASE1_DEV_ENABLED === "true") return true;
  const row = (await db.query<{ enabled: boolean }>(
    `select enabled from channel_feature_flags
      where project_id = $1 and channel_id = $2 and feature_key = $3`,
    [scope.projectId, scope.channelId, RELEASE_1_FEATURE],
  )).rows[0];
  return row?.enabled === true;
}

/** Explicit refresh only: polling GET endpoints never materialize snapshots. */
export async function refreshOpportunitySnapshots(input: {
  actorUserId: number;
  channelId: number | null;
}, db: Queryable = getPool()): Promise<OpportunitySnapshot[]> {
  const scope = await resolveChannelScope(db, input.actorUserId, input.channelId);
  if (!await release1Enabled(db, scope)) throw new ContentIntelligenceError("feature_disabled");
  await syncPublicMarketSignals(db);
  const board = await ensureGrowthBoard({ actorUserId: input.actorUserId, channelId: scope.channelId });
  await materializeOpportunitySnapshots(db, scope, board.moves);
  return listOpportunitySnapshots(input, db);
}

type OpportunityRow = {
  id: string; project_id: string; channel_id: string; channel_title: string | null; channel_handle: string | null;
  revision: number; title: string; independent_angle: string; confidence: Confidence; epistemic_state: EpistemicState;
  formula_version: string; evidence: Record<string, unknown>; observed_at: string | null; expires_at: string;
  source_context_draft_id: string | null;
  growth_move_id?: string; artifact_draft_id?: string | null;
  opportunity_type: OpportunitySnapshot["opportunityType"];
  priority_score: number;
  publish_before: string | null;
  source_count: number;
  user_state: "saved" | "dismissed" | "used" | "not_relevant" | null;
};

function mapOpportunity(row: OpportunityRow, now = new Date()): OpportunitySnapshot {
  const evidence = row.evidence && typeof row.evidence === "object" ? row.evidence : {};
  const expired = new Date(row.expires_at).getTime() <= now.getTime();
  const sourceKind = typeof evidence.sourceKind === "string" ? evidence.sourceKind : null;
  const sources = Array.isArray(evidence.sources) ? evidence.sources.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const value = candidate as Record<string, unknown>;
    if (typeof value.url !== "string" || !/^https:\/\//u.test(value.url)) return [];
    return [{
      url: value.url,
      label: typeof value.label === "string" ? value.label : null,
      trust: Number.isFinite(Number(value.trust)) ? Number(value.trust) : null,
    }];
  }).slice(0, 8) : [];
  return {
    id: Number(row.id), projectId: Number(row.project_id), channelId: Number(row.channel_id), revision: Number(row.revision),
    channelLabel: row.channel_title?.trim() || (row.channel_handle ? `@${row.channel_handle.replace(/^@/u, "")}` : "Канал"),
    title: row.title, angle: row.independent_angle, confidence: row.confidence,
    epistemicState: expired ? "stale" : row.epistemic_state, formulaVersion: row.formula_version,
    observedAt: row.observed_at, expiresAt: row.expires_at,
    freshnessLabel: freshness(row.expires_at, row.observed_at, now),
    sampleSize: safeId(evidence.sampleSize), demand: Number(evidence.demand) || 0,
    coverage: Number(evidence.coverage) || 0, saturation: Number(evidence.saturation) || 0,
    sourceLabel: typeof evidence.sourceLabel === "string" ? evidence.sourceLabel : null,
    sourceType: typeof evidence.sourceType === "string" ? evidence.sourceType : "Источник",
    methodology: typeof evidence.methodology === "string" ? evidence.methodology : "Методика не сохранена",
    sourceContextDraftId: safeId(row.source_context_draft_id),
    actionable: !expired && (safeId(row.growth_move_id) != null || (sourceKind === "competitor_post" && safeId(evidence.sourceId) != null)),
    actionHref: safeId(row.growth_move_id) != null
      ? row.artifact_draft_id ? `/app/composer?draft=${row.artifact_draft_id}&from=opportunities`
        : `/app/studio?growthMove=${row.growth_move_id}&channel=${row.channel_id}&intent=create`
      : undefined,
    opportunityType: row.opportunity_type,
    priorityScore: Number(row.priority_score) || 0,
    publishBefore: row.publish_before,
    sourceCount: Number(row.source_count) || 0,
    sources,
    whyNow: typeof evidence.whyNow === "string" ? evidence.whyNow : null,
    formatSuggestion: typeof evidence.formatSuggestion === "string" ? evidence.formatSuggestion : null,
    userState: row.user_state === "saved" || row.user_state === "used" ? row.user_state : null,
  };
}

export async function listOpportunitySnapshots(input: {
  actorUserId: number;
  channelId: number | null;
}, db: Queryable = getPool()): Promise<OpportunitySnapshot[]> {
  const scope = await resolveChannelScope(db, input.actorUserId, input.channelId);
  if (!await release1Enabled(db, scope)) throw new ContentIntelligenceError("feature_disabled");
  const rows = (await db.query<OpportunityRow>(
    `select snapshot.*, move.id as growth_move_id, move.artifact_draft_id,
            state.state as user_state,
            channel.title as channel_title, channel.handle as channel_handle
       from (
         select distinct on (candidate.growth_move_id) candidate.*
           from opportunity_snapshots candidate
          where candidate.project_id = $1 and candidate.channel_id = $2
            and candidate.expires_at > now()
          order by candidate.growth_move_id, candidate.revision desc
       ) snapshot
       left join growth_moves move on move.id = snapshot.growth_move_id
         and move.project_id = snapshot.project_id and move.channel_id = snapshot.channel_id
      join channels channel on channel.id = snapshot.channel_id and channel.project_id = snapshot.project_id
      left join opportunity_states state on state.project_id = snapshot.project_id
        and state.channel_id = snapshot.channel_id and state.opportunity_snapshot_id = snapshot.id
        and state.user_id = $3
      where coalesce(state.state, '') not in ('dismissed','not_relevant')
      order by snapshot.priority_score desc, snapshot.publish_before asc nulls last,
               snapshot.expires_at desc, snapshot.id desc limit 12`,
    [scope.projectId, scope.channelId, input.actorUserId],
  )).rows;
  return rows.map((row) => mapOpportunity(row));
}

export async function getOpportunityMapContext(input: {
  actorUserId: number;
  channelId: number | null;
}, db: Queryable = getPool()): Promise<OpportunityMapContext> {
  const scope = await resolveChannelScope(db, input.actorUserId, input.channelId);
  const row = (await db.query<{
    profile_ready: boolean; last_refresh_at: string | null; opportunity_count: number;
  }>(
    `select exists(
       select 1 from content_brief brief
        where brief.project_id = $1 and brief.channel_id = $2
          and (nullif(btrim(brief.niche), '') is not null or cardinality(brief.rubrics) > 0)
     ) as profile_ready,
     (select last_success_at::text from today_source_refreshes
       where project_id = $1 and channel_id = $2 and source = 'opportunities') as last_refresh_at,
     (select count(*)::int from opportunity_snapshots
       where project_id = $1 and channel_id = $2 and expires_at > now()) as opportunity_count`,
    [scope.projectId, scope.channelId],
  )).rows[0];
  const profileReady = row?.profile_ready === true;
  return {
    profileReady,
    researchState: !profileReady ? "profile_required" : Number(row?.opportunity_count ?? 0) > 0 ? "ready" : "researching",
    lastRefreshAt: row?.last_refresh_at ?? null,
  };
}

export async function setOpportunityState(input: {
  actorUserId: number;
  opportunityId: number;
  state: "saved" | "dismissed" | "used" | "not_relevant";
  reasonCode?: "wrong_topic" | "already_covered" | "weak_source" | "bad_timing" | "other" | null;
}, db: Queryable = getPool()): Promise<void> {
  const membership = await requireSelectedProjectPermission(db, input.actorUserId, "project.read");
  const snapshot = (await db.query<{ channel_id: string }>(
    `select channel_id from opportunity_snapshots where id = $1 and project_id = $2`,
    [input.opportunityId, membership.projectId],
  )).rows[0];
  if (!snapshot) throw new ContentIntelligenceError("opportunity_not_found");
  await db.query(
    `insert into opportunity_states
       (project_id, channel_id, user_id, opportunity_snapshot_id, state, reason_code)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (project_id, channel_id, user_id, opportunity_snapshot_id) do update
       set state=excluded.state, reason_code=excluded.reason_code,
           version=opportunity_states.version + 1, updated_at=now()`,
    [membership.projectId, Number(snapshot.channel_id), input.actorUserId, input.opportunityId, input.state, input.reasonCode ?? null],
  );
}

export async function clearOpportunityState(input: {
  actorUserId: number;
  opportunityId: number;
}, db: Queryable = getPool()): Promise<void> {
  const membership = await requireSelectedProjectPermission(db, input.actorUserId, "project.read");
  await db.query(
    `delete from opportunity_states state
      using opportunity_snapshots snapshot
      where state.project_id = $1 and state.user_id = $2
        and state.opportunity_snapshot_id = $3
        and snapshot.id = state.opportunity_snapshot_id
        and snapshot.project_id = state.project_id and snapshot.channel_id = state.channel_id`,
    [membership.projectId, input.actorUserId, input.opportunityId],
  );
}

export async function createOpportunitySourceContext(input: {
  actorUserId: number;
  opportunityId: number;
}, db: Queryable = getPool()) {
  const membership = await requireSelectedProjectPermission(db, input.actorUserId, "content.create");
  const row = (await db.query<{
    id: string; channel_id: string; expires_at: string; source_context_draft_id: string | null;
    title: string; angle: string; evidence: Record<string, unknown>;
  }>(
    `select id, channel_id, title, independent_angle as angle, expires_at::text, source_context_draft_id, evidence
       from opportunity_snapshots where id = $1 and project_id = $2`,
    [input.opportunityId, membership.projectId],
  )).rows[0];
  if (!row) throw new ContentIntelligenceError("opportunity_not_found");
  if (new Date(row.expires_at).getTime() <= Date.now()) throw new ContentIntelligenceError("opportunity_stale");
  const sourceId = safeId(row.evidence?.sourceId);
  if (row.evidence?.sourceKind !== "competitor_post" || !sourceId) {
    throw new ContentIntelligenceError("opportunity_not_actionable");
  }
  const result = await createDraftForUser(input.actorUserId, {
    text: "Сервер заменит этот текст точным контекстом источника.", formatting: [], media: null,
    scheduledAt: null, origin: "competitor",
    sourceRef: {
      kind: "competitor",
      id: String(sourceId),
      label: "Источник возможности",
      semanticGoal: `Создать актуальный материал по возможности «${row.title}». ${row.angle}`.slice(0, 500),
    },
    channelIds: [Number(row.channel_id)], aiValidation: null,
    clientKey: `opportunity-source:${input.opportunityId}:${row.channel_id}`,
  });
  await db.query(
    `update opportunity_snapshots set source_context_draft_id = coalesce(source_context_draft_id, $3)
      where id = $1 and project_id = $2`,
    [input.opportunityId, membership.projectId, result.draft.id],
  );
  return { draftId: result.draft.id, created: result.created };
}

export async function createPublishedPostSourceContext(input: {
  actorUserId: number;
  postId: number;
  channelId: number;
  mode: "continue" | "improve";
}) {
  if (!Number.isSafeInteger(input.postId) || input.postId <= 0) {
    throw new ContentIntelligenceError("post_not_found");
  }
  if (!Number.isSafeInteger(input.channelId) || input.channelId <= 0) {
    throw new ContentIntelligenceError("channel_not_found");
  }
  const semanticGoal = input.mode === "continue"
    ? "Развить тему новым ракурсом без копирования исходной публикации."
    : "Подготовить более ясную и полезную версию темы, не изменяя опубликованный материал.";
  const result = await createDraftForUser(input.actorUserId, {
    text: "Сервер заменит этот текст опубликованным материалом канала.",
    formatting: [],
    media: null,
    scheduledAt: null,
    origin: "competitor",
    sourceRef: {
      kind: "reference",
      id: String(input.postId),
      label: "Опубликованный материал канала",
      semanticGoal,
      provenance: {
        kind: "saved_reference",
        id: String(input.postId),
        label: "Опубликованный материал канала",
      },
    },
    channelIds: [input.channelId],
    aiValidation: null,
    clientKey: `today-post:${input.mode}:${input.postId}:${input.channelId}`,
  });
  return { draftId: result.draft.id, created: result.created };
}

export function isContentIntelligenceError(error: unknown): error is ContentIntelligenceError {
  return error instanceof ContentIntelligenceError;
}
