import type { Pool } from "pg";

import type { AuroraProductEventDraft } from "./product-event-contract.mjs";
import { insertProductEvent, observeRelease } from "./product-event-store.mjs";
import { auroraReleaseMetadata, type AuroraReleaseMetadata } from "./release-metadata";

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
      if (await insertProductEvent(client, { ...input, event, release })) accepted += 1;
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
