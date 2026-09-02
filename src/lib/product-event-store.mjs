/**
 * Persistence for validated Aurora product events. Shared by the browser ingestion route
 * (TypeScript) and server-side emitters in the worker (ESM), so the raw table and the
 * daily rollup are always written by exactly one piece of SQL.
 *
 * @typedef {{ query: (text: string, values?: unknown[]) => Promise<{ rowCount: number | null; rows: unknown[] }> }} Queryable
 */

/**
 * @param {Queryable} db
 * @param {{ release: string | null; commitSha: string | null; deployedAt: string | null }} release
 */
export async function observeRelease(db, release) {
  if (!release.release) return;
  await db.query(
    `insert into aurora_releases
       (release_key, commit_sha, deployed_at, first_observed_at, last_observed_at)
     values ($1,$2,$3::timestamptz,now(),now())
     on conflict (release_key) do update set
       commit_sha = coalesce(aurora_releases.commit_sha, excluded.commit_sha),
       deployed_at = coalesce(aurora_releases.deployed_at, excluded.deployed_at),
       last_observed_at = now()`,
    [release.release, release.commitSha, release.deployedAt],
  );
}

/**
 * Inserts one validated event and updates the daily aggregate in the same connection.
 * Returns false when the (project, user, eventId) triple was already stored.
 *
 * @param {Queryable} db
 * @param {{
 *   event: import("./product-event-contract.mjs").AuroraProductEventDraft;
 *   actorUserId: number;
 *   projectId: number;
 *   fallbackRequestId: string;
 *   release: { release: string | null };
 * }} input
 */
export async function insertProductEvent(db, input) {
  const event = input.event;
  const inserted = await db.query(
    `insert into product_events
       (event_id, project_id, user_id, section_id, feature_id, action, stage, outcome,
        duration_ms, error_code, request_id, operation_id, release_key, session_id,
        occurred_at, safe_context, important)
     values ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::uuid,$15::timestamptz,$16::jsonb,$17)
     on conflict (project_id, user_id, event_id) do nothing
     returning id`,
    [
      event.eventId,
      input.projectId,
      input.actorUserId,
      event.sectionId,
      event.featureId,
      event.action,
      event.stage,
      event.outcome,
      event.durationMs,
      event.errorCode,
      event.requestId ?? input.fallbackRequestId,
      event.operationId,
      input.release.release,
      event.sessionId,
      event.occurredAt,
      JSON.stringify(event.safeContext),
      event.important,
    ],
  );
  if (!inserted.rowCount) return false;

  const device = typeof event.safeContext.device === "string" ? event.safeContext.device : "unknown";
  const durationSamples = event.durationMs === null ? 0 : 1;
  await db.query(
    `insert into product_event_daily
       (bucket_date, project_id, user_id, section_id, feature_id, action, stage, outcome,
        error_code, release_key, device, event_count, success_count, failure_count,
        duration_samples, duration_total_ms, duration_min_ms, duration_max_ms,
        first_occurred_at, last_occurred_at, updated_at)
     values (
       ($1::timestamptz at time zone 'UTC')::date,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
       1,$12,$13,$14,$15,$16,$16,$1::timestamptz,$1::timestamptz,now()
     )
     on conflict (
       bucket_date, project_id, user_id, section_id, feature_id, action,
       stage, outcome, error_code, release_key, device
     ) do update set
       event_count = product_event_daily.event_count + 1,
       success_count = product_event_daily.success_count + excluded.success_count,
       failure_count = product_event_daily.failure_count + excluded.failure_count,
       duration_samples = product_event_daily.duration_samples + excluded.duration_samples,
       duration_total_ms = product_event_daily.duration_total_ms + excluded.duration_total_ms,
       duration_min_ms = case
         when product_event_daily.duration_min_ms is null then excluded.duration_min_ms
         when excluded.duration_min_ms is null then product_event_daily.duration_min_ms
         else least(product_event_daily.duration_min_ms, excluded.duration_min_ms)
       end,
       duration_max_ms = case
         when product_event_daily.duration_max_ms is null then excluded.duration_max_ms
         when excluded.duration_max_ms is null then product_event_daily.duration_max_ms
         else greatest(product_event_daily.duration_max_ms, excluded.duration_max_ms)
       end,
       first_occurred_at = least(product_event_daily.first_occurred_at, excluded.first_occurred_at),
       last_occurred_at = greatest(product_event_daily.last_occurred_at, excluded.last_occurred_at),
       updated_at = now()`,
    [
      event.occurredAt,
      input.projectId,
      input.actorUserId,
      event.sectionId,
      event.featureId,
      event.action,
      event.stage,
      event.outcome,
      event.errorCode ?? "",
      input.release.release ?? "",
      device,
      event.outcome === "success" ? 1 : 0,
      event.outcome === "failure" ? 1 : 0,
      durationSamples,
      event.durationMs ?? 0,
      event.durationMs,
    ],
  );
  return true;
}
