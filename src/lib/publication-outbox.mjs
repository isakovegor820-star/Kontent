import { randomUUID } from "node:crypto";

const retryDelaySeconds = (attempts) => Math.min(3600, 60 * (2 ** Math.min(Math.max(0, attempts), 6)));

async function refreshOperationStatus(pool, operationId) {
  const counts = (await pool.query(
    `select count(*)::int as total,
            count(*) filter (where outbox.status = 'pending')::int as pending,
            count(*) filter (where outbox.status = 'enqueued')::int as enqueued,
            count(*) filter (where outbox.status = 'failed')::int as failed,
            count(*) filter (where outbox.status = 'dispatching')::int as dispatching,
            count(*) filter (where post.status = 'published')::int as published,
            count(*) filter (where post.status = 'published_unverified')::int as unverified,
            count(*) filter (where post.status = 'cancelled')::int as cancelled,
            count(*) filter (where post.status in ('failed','quarantined','missing','deleted_external'))::int as terminal_failed,
            count(*) filter (where post.status in ('scheduled','publishing','failed_retry'))::int as active
       from publication_outbox outbox
       join posts post on post.id = outbox.post_id
      where outbox.operation_id = $1`,
    [operationId],
  )).rows[0];
  const total = Number(counts.total || 0);
  const published = Number(counts.published || 0);
  const unverified = Number(counts.unverified || 0);
  const terminalFailed = Number(counts.terminal_failed || 0);
  const cancelled = Number(counts.cancelled || 0);
  const outboxFailed = Number(counts.failed || 0);
  const status = total > 0 && cancelled === total
    ? "cancelled"
    : total > 0 && published === total
    ? "published"
    : total > 0 && published + unverified === total && unverified > 0
      ? "published_unverified"
      : total > 0 && terminalFailed === total
        ? "failed"
        : published + unverified + terminalFailed + cancelled > 0
          ? "partial"
          : total > 0 && outboxFailed === total
            ? "failed"
            : outboxFailed > 0
              ? "partial"
              // pending/dispatching/enqueued are all durable outbox ownership states.
              // A parallel idempotent replay must not downgrade an operation merely because
              // the first request currently holds the short dispatch lease.
              : total > 0
                ? "queued"
                : "pending";
  await pool.query(
    `update publication_operations
        set status = $2, updated_at = now()
      where id = $1 and (status <> 'cancelled' or $2 = 'cancelled')`,
    [operationId, status],
  );
  return status;
}

export async function reconcilePublicationOutbox({
  pool,
  enqueue,
  operationId = null,
  limit = 100,
  now = () => new Date(),
}) {
  const bounded = Math.max(1, Math.min(1000, Number(limit) || 100));
  await pool.query(
    `update publication_outbox
        set status = 'failed', next_attempt_at = now(), lease_token = null,
            lease_expires_at = null, last_error_code = 'dispatch_lease_expired', updated_at = now()
      where status = 'dispatching' and lease_expires_at <= now()
        and ($1::bigint is null or operation_id = $1)`,
    [operationId],
  );
  const touched = new Set();
  const recoverableOperations = await pool.query(
    `select id from publication_operations
      where status in ('pending','partial','queued','published_unverified')
        and ($1::bigint is null or id = $1)
      order by updated_at, id
      limit $2`,
    [operationId, bounded],
  );
  for (const row of recoverableOperations.rows) touched.add(Number(row.id));
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
        `select o.id, o.operation_id, o.post_id, o.attempts,
                p.schedule_revision, p.scheduled_at
           from publication_outbox o join posts p on p.id = o.post_id
          where o.status in ('pending','failed') and o.next_attempt_at <= $2
            and ($1::bigint is null or o.operation_id = $1)
          order by o.next_attempt_at, o.id
          limit 1 for update of o skip locked`,
        [operationId, now()],
      )).rows[0];
      if (!row) {
        await client.query("rollback");
        break;
      }
      await client.query(
        `update publication_outbox
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
    touched.add(Number(row.operation_id));
    try {
      await enqueue(Number(row.post_id), new Date(row.scheduled_at), Number(row.schedule_revision));
      const updated = await pool.query(
        `update publication_outbox
            set status = 'enqueued', attempts = attempts + 1, enqueued_at = now(),
                lease_token = null, lease_expires_at = null,
                last_error_code = null, updated_at = now()
          where id = $1 and status = 'dispatching' and lease_token = $2`,
        [row.id, lease],
      );
      if (updated.rowCount === 1) enqueued += 1;
    } catch (error) {
      const code = String(error?.code || "queue_unavailable").slice(0, 80);
      const seconds = retryDelaySeconds(Number(row.attempts));
      const updated = await pool.query(
        `update publication_outbox
            set status = 'failed', attempts = attempts + 1,
                next_attempt_at = now() + make_interval(secs => $3),
                lease_token = null, lease_expires_at = null,
                last_error_code = $4, updated_at = now()
          where id = $1 and status = 'dispatching' and lease_token = $2`,
        [row.id, lease, seconds, code],
      );
      if (updated.rowCount === 1) failed += 1;
    }
  }
  const statuses = {};
  for (const id of touched) statuses[id] = await refreshOperationStatus(pool, id);
  if (operationId != null && !touched.has(Number(operationId))) {
    statuses[Number(operationId)] = await refreshOperationStatus(pool, Number(operationId));
  }
  return { scanned, enqueued, failed, statuses };
}
