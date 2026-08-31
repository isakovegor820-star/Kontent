import type { Pool, PoolClient } from "pg";

import type { AuroraProductEventDraft } from "./product-event-contract.mjs";
import { auroraReleaseMetadata, type AuroraReleaseMetadata } from "./release-metadata";

type Queryable = Pick<PoolClient, "query">;

export const PRODUCT_EVENT_BATCH_LIMIT = 50;
export const PRODUCT_EVENT_BODY_LIMIT_BYTES = 64 * 1024;
export const DEFAULT_PRODUCT_EVENT_RETENTION_DAYS = 90;

export function productEventRetentionDays(
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = Number(env.AURORA_PRODUCT_EVENT_RETENTION_DAYS);
  return Number.isSafeInteger(parsed) && parsed >= 7 && parsed <= 365
    ? parsed
    : DEFAULT_PRODUCT_EVENT_RETENTION_DAYS;
}

async function observeRelease(db: Queryable, release: AuroraReleaseMetadata): Promise<void> {
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

async function insertEvent(
  db: Queryable,
  input: {
    event: AuroraProductEventDraft;
    actorUserId: number;
    projectId: number;
    fallbackRequestId: string;
    release: AuroraReleaseMetadata;
  },
): Promise<boolean> {
  const event = input.event;
  const inserted = await db.query<{ id: number | string }>(
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

export async function persistAuroraProductEvents(input: {
  pool: Pool;
  actorUserId: number;
  projectId: number;
  events: readonly AuroraProductEventDraft[];
  fallbackRequestId: string;
  release?: AuroraReleaseMetadata;
}): Promise<{ accepted: number; replayed: number; release: string | null }> {
  if (!Number.isSafeInteger(input.actorUserId) || input.actorUserId <= 0) {
    throw new TypeError("invalid_product_event_user");
  }
  if (!Number.isSafeInteger(input.projectId) || input.projectId <= 0) {
    throw new TypeError("invalid_product_event_project");
  }
  if (input.events.length === 0 || input.events.length > PRODUCT_EVENT_BATCH_LIMIT) {
    throw new RangeError("invalid_product_event_batch");
  }

  const release = input.release ?? auroraReleaseMetadata();
  const client = await input.pool.connect();
  try {
    await client.query("begin");
    await observeRelease(client, release);
    let accepted = 0;
    for (const event of input.events) {
      if (await insertEvent(client, { ...input, event, release })) accepted += 1;
    }
    await client.query("commit");
    return { accepted, replayed: input.events.length - accepted, release: release.release };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function pruneExpiredProductEvents(
  pool: Pick<Pool, "query">,
  retentionDays = productEventRetentionDays(),
  batchSize = 5_000,
): Promise<number> {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 7 || retentionDays > 365) {
    throw new RangeError("invalid_product_event_retention");
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new RangeError("invalid_product_event_prune_batch");
  }
  const result = await pool.query(
    `with expired as (
       select id from product_events
        where received_at < now() - make_interval(days => $1::int)
        order by received_at, id
        limit $2
     )
     delete from product_events event
      using expired
      where event.id = expired.id`,
    [retentionDays, batchSize],
  );
  return result.rowCount ?? 0;
}

let nextPruneAt = 0;

/** Opportunistic bounded retention; aggregate rows are intentionally retained. */
export async function maybePruneExpiredProductEvents(
  pool: Pick<Pool, "query">,
  nowMs = Date.now(),
): Promise<number> {
  if (nowMs < nextPruneAt) return 0;
  nextPruneAt = nowMs + 6 * 60 * 60 * 1_000;
  try {
    return await pruneExpiredProductEvents(pool);
  } catch (error) {
    nextPruneAt = 0;
    throw error;
  }
}
