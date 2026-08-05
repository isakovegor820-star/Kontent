import { randomUUID } from "node:crypto";

import { deliverEmailChangeEmail } from "../src/lib/email-change-delivery.mjs";
import { decryptToken } from "../src/lib/token-crypto.mjs";

const safeCode = (value) => /^[a-z0-9._-]{1,80}$/u.test(String(value || ""))
  ? String(value)
  : "delivery_error";

export async function processEmailChangeOutbox(pool, outboxId, options = {}) {
  const lease = randomUUID();
  const client = await pool.connect();
  let row;
  try {
    await client.query("begin");
    row = (await client.query(
      `select o.id, o.user_id, o.request_id, o.generation, o.recipient,
              o.token_envelope, o.attempts, r.expires_at, r.confirmed_at,
              r.cancelled_at, u.email_change_generation
         from email_change_outbox o
         join email_change_requests r on r.id = o.request_id
         join users u on u.id = o.user_id
        where o.id = $1
          and o.status in ('pending','failed') and o.next_attempt_at <= now()
        for update of o skip locked`,
      [outboxId],
    )).rows[0];
    if (!row) {
      await client.query("rollback");
      return { status: "not_due" };
    }
    if (
      row.confirmed_at || row.cancelled_at
      || new Date(row.expires_at).getTime() <= Date.now()
      || Number(row.generation) !== Number(row.email_change_generation)
    ) {
      await client.query(
        `update email_change_outbox
            set status = 'cancelled', last_error_code = 'request_superseded', updated_at = now()
          where id = $1`,
        [outboxId],
      );
      await client.query("commit");
      return { status: "cancelled" };
    }
    await client.query(
      `update email_change_outbox
          set status = 'sending', lease_token = $2,
              lease_expires_at = now() + interval '30 seconds', updated_at = now()
        where id = $1`,
      [outboxId, lease],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  let delivery;
  try {
    const token = decryptToken(row.token_envelope, {
      userId: Number(row.user_id),
      provider: "email-change",
    });
    const appUrl = new URL(String(options.env?.APP_URL || process.env.APP_URL || "")).origin;
    const confirmUrl = new URL("/confirm-email", appUrl);
    confirmUrl.hash = `token=${encodeURIComponent(token)}`;
    delivery = await deliverEmailChangeEmail({
      to: row.recipient,
      confirmUrl: confirmUrl.toString(),
      idempotencyKey: `email-change-${row.request_id}`,
    }, { env: options.env || process.env, fetchImpl: options.fetchImpl || fetch });
  } catch {
    delivery = { ok: false, code: "delivery_error" };
  }

  if (delivery.ok) {
    await pool.query(
      `update email_change_outbox
          set status = 'sent', attempts = attempts + 1, sent_at = now(),
              lease_token = null, lease_expires_at = null, last_error_code = null,
              updated_at = now()
        where id = $1 and status = 'sending' and lease_token = $2`,
      [outboxId, lease],
    );
    return { status: "sent" };
  }

  const attempt = Number(row.attempts) + 1;
  const permanent = delivery.code === "not_configured" || attempt >= 5;
  const retrySeconds = Math.min(3600, 30 * (2 ** Math.min(attempt - 1, 7)));
  await pool.query(
    `with updated as (
       update email_change_outbox
          set status = $3, attempts = attempts + 1,
              next_attempt_at = now() + make_interval(secs => $4),
              lease_token = null, lease_expires_at = null,
              last_error_code = $5, updated_at = now()
        where id = $1 and status = 'sending' and lease_token = $2
        returning request_id
     )
     update email_change_requests r
        set cancelled_at = case when $3 = 'cancelled' then coalesce(r.cancelled_at, now()) else r.cancelled_at end,
            updated_at = now()
       from updated where r.id = updated.request_id`,
    [outboxId, lease, permanent ? "cancelled" : "failed", retrySeconds, safeCode(delivery.code)],
  );
  return { status: permanent ? "cancelled" : "failed", retrySeconds };
}

export async function reconcileEmailChangeOutbox(pool, options = {}) {
  const limit = Math.max(1, Math.min(100, Number(options.limit || 20)));
  await pool.query(
    `update email_change_outbox
        set status = 'failed', next_attempt_at = now(), lease_token = null,
            lease_expires_at = null, last_error_code = 'delivery_lease_expired', updated_at = now()
      where status = 'sending' and lease_expires_at <= now()`,
  );
  const due = await pool.query(
    `select id from email_change_outbox
      where status in ('pending','failed') and next_attempt_at <= now()
      order by next_attempt_at, id limit $1`,
    [limit],
  );
  const outcomes = [];
  for (const row of due.rows) outcomes.push(await processEmailChangeOutbox(pool, Number(row.id), options));
  return outcomes;
}
