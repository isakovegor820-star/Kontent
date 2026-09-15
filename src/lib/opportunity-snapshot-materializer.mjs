import { createHash } from "node:crypto";
import { buildGrowthMoves, growthWeekStart, loadSignals, persistGrowthCandidates } from "./growth-candidates.mjs";
import { opportunityWindow, syncPublicMarketSignals } from "./opportunity-market.mjs";

export const OPPORTUNITY_FORMULA_VERSION = "opportunity-market-v2";

const TOPIC_STOP_WORDS = new Set([
  "как", "для", "или", "что", "это", "про", "свой", "своя", "свои",
  "пост", "напиши", "написать", "канал", "канала",
]);

const sha = (value) => createHash("sha256").update(value, "utf8").digest("hex");

export function normalizeTopicKey(value) {
  const words = String(value).toLocaleLowerCase("ru-RU").replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/u)
    .filter((word) => word.length > 2 && !TOPIC_STOP_WORDS.has(word));
  return [...new Set(words)].join(" ").slice(0, 200) || "topic";
}

function topicLabel(value, sourceKind = null) {
  const text = String(value || "");
  const quoted = sourceKind === "competitor_post" ? text.match(/[«"]([^»"]{3,200})[»"]/u)?.[1]?.trim() : null;
  return (quoted || text.replace(/^напиши\s+(?:свой\s+)?пост\s+про\s+/iu, "").trim() || "Новая тема").slice(0, 200);
}

export function baselineCoverage(topic, ownPostTexts) {
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

export function opportunityFingerprint(move) {
  return sha([
    OPPORTUNITY_FORMULA_VERSION,
    move.weekStart,
    move.fingerprint,
    move.reason ?? "no-reason",
    move.evidence?.profileHash ?? "no-profile",
    move.evidence?.priorityScore ?? 0,
    move.evidence?.sourceCount ?? move.evidence?.sampleSize ?? 0,
  ].join(":"));
}

export function opportunityConfidence(move) {
  if (move.confidence === "answered" && (move.evidence?.sampleSize ?? 0) >= 3) return "high";
  if (move.confidence !== "insufficient_data" && (move.evidence?.sampleSize ?? 0) >= 1) return "medium";
  return "low";
}

export function opportunityExpiry(observedAt, now = new Date(), type = "rising_topic") {
  return opportunityWindow(type, observedAt, now).expiresAt;
}

function evidenceObject(move, coverage) {
  return {
    sourceType: move.evidence?.sourceType,
    sourceLabel: move.evidence?.sourceLabel,
    sourceKind: move.sourceKind,
    sourceId: move.sourceId,
    sourceHref: move.evidence?.href,
    sampleSize: move.evidence?.sampleSize,
    periodLabel: move.evidence?.periodLabel,
    methodology: move.evidence?.methodology,
    metricLabel: move.evidence?.metricLabel,
    demand: Math.max(0, Math.min(4, move.evidence?.opportunityStrength ?? 0)),
    coverage,
    saturation: Math.max(0, Math.min(4, Math.ceil((100 - (move.evidence?.whitespaceScore ?? 50)) / 25))),
    opportunityType: move.evidence?.opportunityType,
    priorityScore: move.evidence?.priorityScore,
    profileHash: move.evidence?.profileHash,
    publishBefore: move.evidence?.publishBefore,
    sourceCount: move.evidence?.sourceCount ?? move.evidence?.sampleSize ?? 0,
    sources: Array.isArray(move.evidence?.sources) ? move.evidence.sources : [],
    whyNow: move.evidence?.whyNow,
    relevanceScore: move.evidence?.relevanceScore,
    momentumScore: move.evidence?.momentumScore,
    freshnessScore: move.evidence?.freshnessScore,
    trustScore: move.evidence?.trustScore,
    formatSuggestion: move.evidence?.formatSuggestion,
    growthMoveFingerprint: move.fingerprint,
  };
}

/** Materializes immutable revisions. A changed evidence fingerprint creates the next revision. */
export async function materializeOpportunitySnapshots(db, scope, moves) {
  const candidates = moves.filter(
    (move) => ["topic", "offer", "audience"].includes(move.kind) && move.sourceId,
  );
  if (candidates.length === 0) return { candidates: 0, inserted: 0 };
  const ownPostTexts = (await db.query(
    `select text from posts where project_id = $1 and channel_id = $2
      and status in ('published','published_unverified')
      and published_at >= now() - interval '30 days' order by published_at desc limit 200`,
    [scope.projectId, scope.channelId],
  )).rows.map((row) => row.text);
  let inserted = 0;
  const now = new Date();
  for (const move of candidates) {
    const observedAt = move.evidence?.observedAt ?? null;
    const opportunityType = move.evidence?.opportunityType ?? (move.kind === "audience" ? "audience_need" : move.kind === "offer" ? "offer_gap" : move.sourceKind === "competitor_post" ? "competitor_gap" : "evergreen_gap");
    const window = opportunityWindow(opportunityType, observedAt, now);
    const expiresAt = move.evidence?.expiresAt ? new Date(move.evidence.expiresAt) : window.expiresAt;
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) continue;
    const confidence = opportunityConfidence(move);
    const label = topicLabel(move.title, move.sourceKind);
    const fingerprint = opportunityFingerprint(move);
    const latest = (await db.query(
      `select revision, fingerprint from opportunity_snapshots
        where project_id = $1 and channel_id = $2 and growth_move_id = $3
        order by revision desc limit 1`,
      [scope.projectId, scope.channelId, move.id],
    )).rows[0];
    if (latest?.fingerprint === fingerprint) continue;
    const revision = Number(latest?.revision ?? 0) + 1;
    const result = await db.query(
      `insert into opportunity_snapshots
         (project_id, channel_id, growth_move_id, revision, fingerprint, topic_key, title,
          independent_angle, confidence, epistemic_state, formula_version, evidence,
          observed_at, expires_at, opportunity_type, priority_score, publish_before,
          source_count, profile_hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14,
               $15, $16, $17, $18, $19)
       on conflict (growth_move_id, revision) do nothing`,
      [
        scope.projectId,
        scope.channelId,
        move.id,
        revision,
        fingerprint,
        normalizeTopicKey(label),
        label,
        String(move.reason || move.prompt).slice(0, 2_000),
        confidence,
        confidence === "low" ? "insufficient_data" : "inferred",
        OPPORTUNITY_FORMULA_VERSION,
        JSON.stringify(evidenceObject(move, baselineCoverage(label, ownPostTexts))),
        observedAt,
        expiresAt,
        opportunityType,
        Math.max(0, Math.min(100, Math.round(Number(move.evidence?.priorityScore) || 0))),
        move.evidence?.publishBefore ?? window.publishBefore,
        Math.max(0, Math.round(Number(move.evidence?.sourceCount ?? move.evidence?.sampleSize) || 0)),
        move.evidence?.profileHash ?? null,
      ],
    );
    inserted += result.rowCount ?? 0;
  }
  return { candidates: candidates.length, inserted };
}

function mapGrowthMove(row) {
  const evidence = row.evidence && typeof row.evidence === "object" ? row.evidence : {};
  return {
    id: Number(row.id),
    weekStart: String(row.week_start),
    kind: row.kind,
    confidence: row.confidence,
    title: row.title,
    reason: row.reason,
    prompt: row.prompt,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    fingerprint: row.fingerprint,
    evidence: {
      ...evidence,
      sampleSize: evidence.sampleSize == null ? null : Number(evidence.sampleSize),
      opportunityStrength: Number(evidence.opportunityStrength ?? 0),
      observedAt: typeof evidence.observedAt === "string" ? evidence.observedAt : null,
    },
  };
}

async function recordOpportunityRefresh(db, scope, state, errorCode = null) {
  await db.query(
    `insert into today_source_refreshes
       (project_id, channel_id, source, last_attempt_state, last_attempt_at,
        last_success_at, last_error_code, updated_at)
     values ($1, $2, 'opportunities', $3, now(),
             case when $3 = 'success' then now() else null end, $4, now())
     on conflict (project_id, channel_id, source) do update
       set last_attempt_state = excluded.last_attempt_state,
           last_attempt_at = excluded.last_attempt_at,
           last_success_at = case when excluded.last_attempt_state = 'success'
                                  then excluded.last_attempt_at
                                  else today_source_refreshes.last_success_at end,
           last_error_code = excluded.last_error_code,
           updated_at = now()`,
    [scope.projectId, scope.channelId, state, errorCode],
  );
}

/** Worker/scheduler entry point. Discover new candidates without an HTTP visit. */
export async function materializeAllOpportunitySnapshots(db) {
  await syncPublicMarketSignals(db);
  const channels = (await db.query(
    `select channel.project_id, channel.id as channel_id
       from channels channel
       join channel_feature_flags flag
         on flag.project_id = channel.project_id
        and flag.channel_id = channel.id
        and flag.feature_key = 'content_intelligence_release_1'
        and flag.enabled = true
      where channel.is_active = true and channel.status = 'active'
      order by channel.project_id, channel.id`,
  )).rows;
  let inserted = 0;
  let failed = 0;
  for (const channel of channels) {
    const scope = { projectId: Number(channel.project_id), channelId: Number(channel.channel_id) };
    try {
      const signals = await loadSignals(db, scope);
      const weekStart = growthWeekStart();
      const client = await db.connect();
      try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`growth:${scope.channelId}:${weekStart}`]);
        await persistGrowthCandidates(client, scope, buildGrowthMoves(signals, 100), weekStart);
        await client.query(
          `update growth_moves set action_href = case when kind = 'rhythm'
             then '/app/autopilot?growthMove=' || id || '&channel=' || channel_id
             else '/app/studio?growthMove=' || id || '&channel=' || channel_id || '&intent=create' end
           where project_id = $1 and channel_id = $2 and week_start = $3 and action_href = '/app/growth'`,
          [scope.projectId, scope.channelId, weekStart],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally { client.release(); }
      const moves = (await db.query(
        `select id, week_start::text, kind, confidence, title, reason, prompt, source_kind,
                source_id, fingerprint, evidence
           from growth_moves
          where project_id = $1 and channel_id = $2 and status = 'open'
            and week_start >= current_date - interval '14 days'
          order by week_start desc, rank_position nulls last, id`,
        [scope.projectId, scope.channelId],
      )).rows.map(mapGrowthMove);
      const result = await materializeOpportunitySnapshots(db, scope, moves);
      inserted += result.inserted;
      await recordOpportunityRefresh(db, scope, "success");
    } catch {
      failed++;
      await recordOpportunityRefresh(db, scope, "error", "opportunity_refresh_failed").catch(() => undefined);
    }
  }
  return { channels: channels.length, inserted, failed };
}
