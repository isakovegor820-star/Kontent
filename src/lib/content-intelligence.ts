import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { getPool } from "./db";
import { ensureGrowthBoard, type GrowthMoveRecord } from "./growth";
import { requireSelectedProjectPermission } from "./project-permissions";
import { createDraftForUser } from "./server-drafts";

type Queryable = Pick<Pool | PoolClient, "query">;

export const RELEASE_1_FEATURE = "content_intelligence_release_1" as const;
export const OPPORTUNITY_FORMULA_VERSION = "opportunity-baseline-v1" as const;
export const TODAY_RANKING_VERSION = "today-rank-v1" as const;

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

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const TOPIC_STOP_WORDS = new Set(["как", "для", "или", "что", "это", "про", "свой", "своя", "свои", "пост", "напиши", "написать", "канал", "канала"]);

export function normalizeTopicKey(value: string): string {
  const words = value.toLocaleLowerCase("ru-RU").replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/u)
    .filter((word) => word.length > 2 && !TOPIC_STOP_WORDS.has(word));
  return [...new Set(words)].join(" ").slice(0, 200) || "topic";
}

function topicLabel(value: string): string {
  const quoted = value.match(/[«"]([^»"]{3,200})[»"]/u)?.[1]?.trim();
  return (quoted || value.replace(/^напиши\s+(?:свой\s+)?пост\s+про\s+/iu, "").trim() || "Новая тема").slice(0, 200);
}

export function baselineCoverage(topic: string, ownPostTexts: string[]): number {
  const topicTokens = new Set(normalizeTopicKey(topic).split(" "));
  if (topicTokens.size === 0) return 0;
  const minimumMatches = Math.min(2, topicTokens.size);
  const covered = ownPostTexts.filter((text) => {
    const postTokens = new Set(normalizeTopicKey(text).split(" "));
    let overlap = 0;
    for (const token of topicTokens) if (postTokens.has(token)) overlap++;
    return overlap >= minimumMatches && overlap / topicTokens.size >= 0.4;
  }).length;
  return Math.min(4, covered);
}

export function opportunityFingerprint(move: Pick<GrowthMoveRecord, "fingerprint" | "weekStart">): string {
  return sha(`${OPPORTUNITY_FORMULA_VERSION}:${move.weekStart}:${move.fingerprint}`);
}

export function opportunityConfidence(move: Pick<GrowthMoveRecord, "confidence" | "evidence">): Confidence {
  if (move.confidence === "answered" && (move.evidence.sampleSize ?? 0) >= 3) return "high";
  if (move.confidence !== "insufficient_data" && (move.evidence.sampleSize ?? 0) >= 1) return "medium";
  return "low";
}

export function opportunityExpiry(observedAt: string | null, now = new Date()): Date {
  const observed = observedAt ? new Date(observedAt) : now;
  const base = Number.isFinite(observed.getTime()) ? observed : now;
  return new Date(Math.max(base.getTime(), now.getTime()) + 7 * 86_400_000);
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

function evidenceObject(move: GrowthMoveRecord, coverage: number) {
  return {
    sourceType: move.evidence.sourceType,
    sourceLabel: move.evidence.sourceLabel,
    sourceKind: move.sourceKind,
    sourceId: move.sourceId,
    sourceHref: move.evidence.href,
    sampleSize: move.evidence.sampleSize,
    periodLabel: move.evidence.periodLabel,
    methodology: move.evidence.methodology,
    metricLabel: move.evidence.metricLabel,
    demand: Math.max(0, Math.min(4, move.evidence.opportunityStrength)),
    coverage,
    saturation: Math.max(1, Math.min(4, move.evidence.opportunityStrength - 1)),
    growthMoveFingerprint: move.fingerprint,
  };
}

/** Explicit refresh only: polling GET endpoints never materialize snapshots. */
export async function refreshOpportunitySnapshots(input: {
  actorUserId: number;
  channelId: number | null;
}, db: Queryable = getPool()): Promise<OpportunitySnapshot[]> {
  const scope = await resolveChannelScope(db, input.actorUserId, input.channelId);
  if (!await release1Enabled(db, scope)) throw new ContentIntelligenceError("feature_disabled");
  const board = await ensureGrowthBoard({ actorUserId: input.actorUserId, channelId: scope.channelId });
  const candidates = board.moves.filter(
    (move) => move.kind === "topic" && move.sourceKind === "competitor_post" && move.sourceId,
  );
  const ownPostTexts = (await db.query<{ text: string }>(
    `select text from posts where project_id = $1 and channel_id = $2
      and status in ('published','published_unverified')
      and published_at >= now() - interval '30 days' order by published_at desc limit 200`,
    [scope.projectId, scope.channelId],
  )).rows.map((row) => row.text);
  for (const move of candidates) {
    const observedAt = move.evidence.observedAt;
    const expiresAt = opportunityExpiry(observedAt);
    const confidence = opportunityConfidence(move);
    const label = topicLabel(move.title);
    const topicKey = normalizeTopicKey(label);
    const coverage = baselineCoverage(label, ownPostTexts);
    await db.query(
      `insert into opportunity_snapshots
         (project_id, channel_id, growth_move_id, revision, fingerprint, topic_key, title,
          independent_angle, confidence, epistemic_state, formula_version, evidence,
          observed_at, expires_at)
       values ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
       on conflict (growth_move_id, revision) do nothing`,
      [scope.projectId, scope.channelId, move.id, opportunityFingerprint(move), topicKey,
        label, move.prompt.slice(0, 2_000), confidence,
        confidence === "low" ? "insufficient_data" : "inferred", OPPORTUNITY_FORMULA_VERSION,
        JSON.stringify(evidenceObject(move, coverage)), observedAt, expiresAt],
    );
  }
  return listOpportunitySnapshots(input, db);
}

type OpportunityRow = {
  id: string; project_id: string; channel_id: string; channel_title: string | null; channel_handle: string | null;
  revision: number; title: string; independent_angle: string; confidence: Confidence; epistemic_state: EpistemicState;
  formula_version: string; evidence: Record<string, unknown>; observed_at: string | null; expires_at: string;
  source_context_draft_id: string | null;
};

function mapOpportunity(row: OpportunityRow, now = new Date()): OpportunitySnapshot {
  const evidence = row.evidence && typeof row.evidence === "object" ? row.evidence : {};
  const expired = new Date(row.expires_at).getTime() <= now.getTime();
  const sourceKind = typeof evidence.sourceKind === "string" ? evidence.sourceKind : null;
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
    actionable: !expired && sourceKind === "competitor_post" && safeId(evidence.sourceId) != null,
  };
}

export async function listOpportunitySnapshots(input: {
  actorUserId: number;
  channelId: number | null;
}, db: Queryable = getPool()): Promise<OpportunitySnapshot[]> {
  const scope = await resolveChannelScope(db, input.actorUserId, input.channelId);
  if (!await release1Enabled(db, scope)) throw new ContentIntelligenceError("feature_disabled");
  const rows = (await db.query<OpportunityRow>(
    `select snapshot.*, channel.title as channel_title, channel.handle as channel_handle
       from opportunity_snapshots snapshot
       join channels channel on channel.id = snapshot.channel_id and channel.project_id = snapshot.project_id
      where snapshot.project_id = $1 and snapshot.channel_id = $2
      order by snapshot.expires_at desc, snapshot.id desc limit 50`,
    [scope.projectId, scope.channelId],
  )).rows;
  return rows.map((row) => mapOpportunity(row));
}

export async function createOpportunitySourceContext(input: {
  actorUserId: number;
  opportunityId: number;
}, db: Queryable = getPool()) {
  const membership = await requireSelectedProjectPermission(db, input.actorUserId, "content.create");
  const row = (await db.query<{
    id: string; channel_id: string; expires_at: string; source_context_draft_id: string | null;
    evidence: Record<string, unknown>;
  }>(
    `select id, channel_id, expires_at::text, source_context_draft_id, evidence
       from opportunity_snapshots where id = $1 and project_id = $2`,
    [input.opportunityId, membership.projectId],
  )).rows[0];
  if (!row) throw new ContentIntelligenceError("opportunity_not_found");
  if (new Date(row.expires_at).getTime() <= Date.now()) throw new ContentIntelligenceError("opportunity_stale");
  if (row.source_context_draft_id) return { draftId: Number(row.source_context_draft_id), created: false };
  const sourceId = safeId(row.evidence?.sourceId);
  if (row.evidence?.sourceKind !== "competitor_post" || !sourceId) {
    throw new ContentIntelligenceError("opportunity_not_actionable");
  }
  const result = await createDraftForUser(input.actorUserId, {
    text: "Сервер заменит этот текст точным контекстом источника.", formatting: [], media: null,
    scheduledAt: null, origin: "competitor",
    sourceRef: { kind: "competitor", id: String(sourceId), label: "Источник возможности" },
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

export function isContentIntelligenceError(error: unknown): error is ContentIntelligenceError {
  return error instanceof ContentIntelligenceError;
}
