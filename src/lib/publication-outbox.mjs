import { randomUUID } from "node:crypto";

const retryDelaySeconds = (attempts) => Math.min(3600, 60 * (2 ** Math.min(Math.max(0, attempts), 6)));

async function refreshOperationStatus(pool, operationId) {
  const counts = (await pool.query(
    `select count(*)::int as total,
            count(*) filter (where status = 'enqueued')::int as enqueued,
            count(*) filter (where status = 'failed')::int as failed,
            count(*) filter (where status = 'dispatching')::int as dispatching
       from publication_outbox where operation_id = $1`,
    [operationId],
  )).rows[0];
  const status = counts.total > 0 && counts.enqueued === counts.total
    ? "queued"
    : counts.enqueued > 0
      ? "partial"
      : counts.failed > 0
        ? "failed"
        : "pending";
  await pool.query(
    "update publication_operations set status = $2, updated_at = now() where id = $1",
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
