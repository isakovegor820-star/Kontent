import { randomUUID } from "node:crypto";

const MAX_DISPATCH_ATTEMPTS = 10;

function retryDelaySeconds(attempts) {
  return Math.min(3600, 15 * (2 ** Math.min(Math.max(0, Number(attempts) || 0), 8)));
}

/**
 * Replays durable DB ownership into a deterministic BullMQ job. `enqueued` rows are
 * periodically replayed too: adding the same job id is harmless and repairs Redis loss.
 */
export async function reconcileProjectExportOutbox({
  pool,
  enqueue,
  operationId = null,
  limit = 100,
  now = () => new Date(),
}) {
  const bounded = Math.max(1, Math.min(500, Number(limit) || 100));
  // A process can die after claiming an operation but before recording the attempt.
  // Requeue only stale render leases; even a large PDF gets a thirty-minute window.
  await pool.query(
    `with stale as (
       update project_export_operations operation
          set status = 'retryable_failed', error_code = 'render_lease_expired',
              error_message = 'Формирование файла будет повторено автоматически.',
              updated_at = now()
        where operation.status = 'rendering'
          and operation.updated_at <= now() - interval '30 minutes'
          and ($1::bigint is null or operation.id = $1)
          and exists (
            select 1 from project_export_outbox outbox
             where outbox.operation_id = operation.id
               and outbox.project_id = operation.project_id
               and outbox.status not in ('failed','cancelled')
          )
        returning operation.id, operation.project_id
     )
     update project_export_outbox outbox
        set status = 'retryable_failed', next_attempt_at = now(),
            lease_token = null, lease_expires_at = null,
            last_error_code = 'render_lease_expired', updated_at = now()
       from stale
      where outbox.operation_id = stale.id and outbox.project_id = stale.project_id`,
    [operationId],
  );
  await pool.query(
    `update project_export_outbox
        set status = 'retryable_failed', lease_token = null, lease_expires_at = null,
            last_error_code = 'dispatch_lease_expired', next_attempt_at = now(), updated_at = now()
      where status = 'dispatching' and lease_expires_at <= now()
        and ($1::bigint is null or operation_id = $1)`,
    [operationId],
  );
  let scanned = 0;
  let enqueued = 0;
  let failed = 0;
  while (scanned < bounded) {
    const lease = randomUUID();
    const client = await pool.connect();
    let row;
    try {
      await client.query("begin");
      row = (await client.query(
        `select outbox.id, outbox.operation_id, outbox.project_id, outbox.status as outbox_status,
                outbox.attempts,
                operation.snapshot_hash
           from project_export_outbox outbox
           join project_export_operations operation
             on operation.id = outbox.operation_id and operation.project_id = outbox.project_id
          where operation.status in ('pending','queued','retryable_failed')
            and ($1::bigint is null or operation.id = $1)
            and (
              (outbox.status in ('pending','retryable_failed') and outbox.next_attempt_at <= $2)
              or (outbox.status = 'enqueued' and outbox.updated_at <= $2 - interval '5 minutes')
            )
          order by outbox.next_attempt_at, outbox.id
          limit 1 for update of outbox skip locked`,
        [operationId, now()],
      )).rows[0];
      if (!row) {
        await client.query("rollback");
        break;
      }
      await client.query(
        `update project_export_outbox
            set status = 'dispatching', lease_token = $2,
                lease_expires_at = now() + interval '30 seconds', updated_at = now()
          where id = $1`,
        [row.id, lease],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    scanned += 1;
    try {
      await enqueue({
        operationId: Number(row.operation_id),
        projectId: Number(row.project_id),
        snapshotHash: String(row.snapshot_hash),
      });
      const updated = await pool.query(
        `update project_export_outbox
            set status = 'enqueued',
                attempts = attempts + case when $3::boolean then 0 else 1 end,
                enqueued_at = now(),
                lease_token = null, lease_expires_at = null, last_error_code = null,
                updated_at = now()
          where id = $1 and status = 'dispatching' and lease_token = $2`,
        [row.id, lease, row.outbox_status === "enqueued"],
      );
      if (updated.rowCount === 1) {
        await pool.query(
          `update project_export_operations
              set status = 'queued', error_code = null, error_message = null, updated_at = now()
            where id = $1 and project_id = $2
              and status in ('pending','retryable_failed','queued')`,
          [row.operation_id, row.project_id],
        );
        enqueued += 1;
      }
    } catch (error) {
      const nextAttempts = Number(row.attempts) + 1;
      const terminal = nextAttempts >= MAX_DISPATCH_ATTEMPTS;
      const code = String(error?.code || "queue_unavailable").replace(/[^a-z0-9_:-]/giu, "_").slice(0, 100);
      const updated = await pool.query(
        `update project_export_outbox
            set status = $3, attempts = attempts + 1,
                next_attempt_at = now() + make_interval(secs => $4),
                lease_token = null, lease_expires_at = null,
                last_error_code = $5, updated_at = now()
          where id = $1 and status = 'dispatching' and lease_token = $2`,
        [row.id, lease, terminal ? "failed" : "retryable_failed", retryDelaySeconds(row.attempts), code],
      );
      if (updated.rowCount === 1) {
        await pool.query(
          `update project_export_operations
              set status = $3, error_code = $4,
                  error_message = $5, updated_at = now(),
                  completed_at = case when $3 = 'failed' then now() else null end
            where id = $1 and project_id = $2
              and status in ('pending','queued','retryable_failed')`,
          [
            row.operation_id,
            row.project_id,
            terminal ? "failed" : "retryable_failed",
            code,
            terminal ? "Не удалось передать экспорт в очередь после повторных попыток." : "Экспорт ожидает восстановления очереди.",
          ],
        );
        failed += 1;
      }
    }
  }
  return { scanned, enqueued, failed };
}

export async function expireProjectExportArtifacts(pool, limit = 500) {
  const bounded = Math.max(1, Math.min(2_000, Number(limit) || 500));
  const client = await pool.connect();
  try {
    await client.query("begin");
    const expired = await client.query(
      `select artifact.id, artifact.operation_id
         from project_export_artifacts artifact
        where artifact.expires_at <= now()
        order by artifact.expires_at, artifact.id
        limit $1 for update skip locked`,
      [bounded],
    );
    const operationIds = expired.rows.map((row) => Number(row.operation_id));
    if (operationIds.length > 0) {
      await client.query(
        `update project_export_operations
            set status = 'expired', updated_at = now(), completed_at = coalesce(completed_at, now())
          where id = any($1::bigint[]) and status = 'ready'`,
        [operationIds],
      );
      await client.query(
        `delete from project_export_artifacts where id = any($1::bigint[])`,
        [expired.rows.map((row) => Number(row.id))],
      );
    }
    await client.query(
      `delete from project_export_download_tokens
        where id in (
          select id from project_export_download_tokens
           where expires_at <= now() or revoked_at is not null
           order by expires_at, id limit $1
        )`,
      [bounded],
    );
    await client.query("commit");
    return { expiredArtifacts: operationIds.length };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
