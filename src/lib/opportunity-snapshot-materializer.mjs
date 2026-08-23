import { createHash } from "node:crypto";

export const OPPORTUNITY_FORMULA_VERSION = "opportunity-baseline-v1";

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

function topicLabel(value) {
  const text = String(value || "");
  const quoted = text.match(/[«"]([^»"]{3,200})[»"]/u)?.[1]?.trim();
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
  return sha(`${OPPORTUNITY_FORMULA_VERSION}:${move.weekStart}:${move.fingerprint}`);
}

export function opportunityConfidence(move) {
  if (move.confidence === "answered" && (move.evidence?.sampleSize ?? 0) >= 3) return "high";
  if (move.confidence !== "insufficient_data" && (move.evidence?.sampleSize ?? 0) >= 1) return "medium";
  return "low";
}

export function opportunityExpiry(observedAt, now = new Date()) {
  const observed = observedAt ? new Date(observedAt) : now;
  const base = Number.isFinite(observed.getTime()) ? observed : now;
  return new Date(Math.max(base.getTime(), now.getTime()) + 7 * 86_400_000);
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
    saturation: Math.max(1, Math.min(4, (move.evidence?.opportunityStrength ?? 1) - 1)),
    growthMoveFingerprint: move.fingerprint,
  };
}

/** Materializes immutable revision 1 snapshots. Replays are safe by both scoped uniques. */
export async function materializeOpportunitySnapshots(db, scope, moves) {
  const candidates = moves.filter(
    (move) => move.kind === "topic" && move.sourceKind === "competitor_post" && move.sourceId,
  );
  if (candidates.length === 0) return { candidates: 0, inserted: 0 };
  const ownPostTexts = (await db.query(
    `select text from posts where project_id = $1 and channel_id = $2
      and status in ('published','published_unverified')
      and published_at >= now() - interval '30 days' order by published_at desc limit 200`,
    [scope.projectId, scope.channelId],
  )).rows.map((row) => row.text);
  let inserted = 0;
  for (const move of candidates) {
    const observedAt = move.evidence?.observedAt ?? null;
    const expiresAt = opportunityExpiry(observedAt);
    const confidence = opportunityConfidence(move);
    const label = topicLabel(move.title);
    const result = await db.query(
      `insert into opportunity_snapshots
         (project_id, channel_id, growth_move_id, revision, fingerprint, topic_key, title,
          independent_angle, confidence, epistemic_state, formula_version, evidence,
          observed_at, expires_at)
       values ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
       on conflict (growth_move_id, revision) do nothing`,
      [
        scope.projectId,
        scope.channelId,
        move.id,
        opportunityFingerprint(move),
        normalizeTopicKey(label),
        label,
        String(move.prompt).slice(0, 2_000),
        confidence,
        confidence === "low" ? "insufficient_data" : "inferred",
        OPPORTUNITY_FORMULA_VERSION,
        JSON.stringify(evidenceObject(move, baselineCoverage(label, ownPostTexts))),
        observedAt,
        expiresAt,
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

/** Worker/scheduler entry point. Existing growth moves are refreshed without an HTTP actor. */
export async function materializeAllOpportunitySnapshots(db) {
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
      const moves = (await db.query(
        `select id, week_start::text, kind, confidence, title, prompt, source_kind,
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
