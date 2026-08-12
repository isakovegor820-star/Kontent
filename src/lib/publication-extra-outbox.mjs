import { randomUUID } from "node:crypto";

const MAX_DISPATCH_ATTEMPTS = 10;

function retryDelaySeconds(attempts) {
  return Math.min(3_600, 15 * (2 ** Math.min(Math.max(0, Number(attempts) || 0), 8)));
}

/** Replays DB ownership into deterministic BullMQ jobs and repairs expired leases. */
export async function reconcilePublicationExtraOutbox({
  pool,
  enqueue,
  operationId = null,
  limit = 100,
  now = () => new Date(),
}) {
  const bounded = Math.max(1, Math.min(500, Number(limit) || 100));
  // Telegram sendMessage has no provider idempotency key. If a process died after the
  // request started, fail visibly rather than risk a duplicate first comment.
  await pool.query(
    `with stale as (
       update publication_extra_operations operation
          set status = case
                when operation.kind = 'first_comment'
                 and operation.request_snapshot->>'providerId' = 'tg'
                 and operation.provider_started_at is not null
                then 'failed' else 'failed_retry' end,
              last_error_code = case
                when operation.kind = 'first_comment'
                 and operation.request_snapshot->>'providerId' = 'tg'
                 and operation.provider_started_at is not null
                then 'delivery_unknown' else 'execution_lease_expired' end,
              last_error_message = case
                when operation.kind = 'first_comment'
                 and operation.request_snapshot->>'providerId' = 'tg'
                 and operation.provider_started_at is not null
                then 'Telegram не подтвердил комментарий. Проверьте публикацию перед повтором.'
                else 'Дополнительное действие будет повторено автоматически.' end,
              attempts = operation.attempts + 1,
              lease_token = null, lease_expires_at = null, updated_at = now()
        where operation.status = 'running'
          and operation.lease_expires_at <= now()
          and ($1::bigint is null or operation.id = $1)
        returning operation.id, operation.project_id, operation.status,
                  operation.attempts as attempt_number
     ), attempt as (
       update publication_extra_attempts journal
          set status = stale.status,
              safe_error_code = case when stale.status = 'failed'
                then 'delivery_unknown' else 'execution_lease_expired' end,
              completed_at = now()
         from stale
        where journal.operation_id = stale.id and journal.project_id = stale.project_id
          and journal.attempt_number = stale.attempt_number and journal.status = 'running'
     )
     update publication_extra_outbox outbox
        set status = case when stale.status = 'failed' then 'completed' else 'failed' end,
            next_attempt_at = case when stale.status = 'failed' then outbox.next_attempt_at else now() end,
            lease_token = null, lease_expires_at = null,
            last_error_code = case when stale.status = 'failed' then 'delivery_unknown' else 'execution_lease_expired' end,
            updated_at = now()
       from stale
      where outbox.operation_id = stale.id and outbox.project_id = stale.project_id`,
    [operationId],
  );
  await pool.query(
    `update publication_extra_outbox
        set status = 'failed', lease_token = null, lease_expires_at = null,
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
        `select outbox.id, outbox.operation_id, outbox.project_id,
                outbox.status as outbox_status, outbox.attempts, operation.fingerprint
           from publication_extra_outbox outbox
           join publication_extra_operations operation
             on operation.id = outbox.operation_id and operation.project_id = outbox.project_id
          where operation.status in ('pending','queued','failed_retry')
            and ($1::bigint is null or operation.id = $1)
            and (
              (outbox.status in ('pending','failed') and outbox.next_attempt_at <= $2)
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
        `update publication_extra_outbox
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
        fingerprint: String(row.fingerprint),
      });
      const updated = await pool.query(
        `update publication_extra_outbox
            set status = 'enqueued',
                attempts = attempts + case when $3::boolean then 0 else 1 end,
                enqueued_at = now(), lease_token = null, lease_expires_at = null,
                last_error_code = null, updated_at = now()
          where id = $1 and status = 'dispatching' and lease_token = $2`,
        [row.id, lease, row.outbox_status === "enqueued"],
      );
      if (updated.rowCount === 1) {
        await pool.query(
          `update publication_extra_operations
              set status = 'queued', last_error_code = null,
                  last_error_message = null, updated_at = now()
            where id = $1 and project_id = $2 and status in ('pending','failed_retry','queued')`,
          [row.operation_id, row.project_id],
        );
        enqueued += 1;
      }
    } catch (error) {
      const nextAttempts = Number(row.attempts) + 1;
      const terminal = nextAttempts >= MAX_DISPATCH_ATTEMPTS;
      const code = String(error?.code || "queue_unavailable").replace(/[^a-z0-9_:-]/giu, "_").slice(0, 100);
      const updated = await pool.query(
        `update publication_extra_outbox
            set status = $3, attempts = attempts + 1,
                next_attempt_at = now() + make_interval(secs => $4),
                lease_token = null, lease_expires_at = null,
                last_error_code = $5, updated_at = now()
          where id = $1 and status = 'dispatching' and lease_token = $2`,
        [row.id, lease, terminal ? "completed" : "failed", retryDelaySeconds(row.attempts), code],
      );
      if (updated.rowCount === 1) {
        await pool.query(
          `update publication_extra_operations
              set status = $3, last_error_code = $4,
                  last_error_message = $5, updated_at = now(),
                  completed_at = case when $3 = 'failed' then now() else completed_at end
            where id = $1 and project_id = $2 and status in ('pending','queued','failed_retry')`,
          [
            row.operation_id,
            row.project_id,
            terminal ? "failed" : "failed_retry",
            code,
            terminal
              ? "Не удалось передать действие в очередь после повторных попыток."
              : "Действие ожидает восстановления очереди.",
          ],
        );
        failed += 1;
      }
    }
  }
  return { scanned, enqueued, failed };
}
