// Durable, replay-safe quota reservations for worker jobs. This module has no pool,
// Redis, fetch, or process lifecycle side effects so it can be unit-tested in isolation.

const configuredLimit = Number(process.env.AI_DAILY_LIMIT || 30);
export const WORKER_AI_DAILY_LIMIT = Number.isFinite(configuredLimit)
  ? Math.min(100_000, Math.max(1, Math.round(configuredLimit)))
  : 30;

const configuredTtl = Number(process.env.AI_WORKER_RESERVATION_TTL_MS || 120_000);
export const WORKER_AI_RESERVATION_TTL_MS = Number.isFinite(configuredTtl)
  ? Math.min(60 * 60_000, Math.max(10_000, Math.round(configuredTtl)))
  : 120_000;

export const WORKER_AI_RECLAIM_AFTER_MS = 15_000;
const CLEANUP_BATCH = 100;
const KEY = /^[a-z0-9][a-z0-9:_-]{7,127}$/u;

function positiveInt(value, fallback, max) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(max, Math.max(1, Math.round(numeric))) : fallback;
}

function positiveId(value, label) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) throw new TypeError(`${label}: invalid id`);
  return numeric;
}

export function workerAiUsageKey(scope, operationId) {
  const safeScope = String(scope ?? "").trim().toLowerCase();
  const safeId = positiveId(operationId, "ai usage operation");
  const key = `worker:${safeScope}:${safeId}`;
  if (!KEY.test(key)) throw new TypeError("ai usage operation: invalid scope");
  return key;
}

/** Stable key for a recurring logical operation, for example channel + Moscow week. */
export function workerAiUsageCompositeKey(scope, operationParts) {
  const safeScope = String(scope ?? "").trim().toLowerCase();
  const parts = Array.isArray(operationParts) ? operationParts : [];
  if (!parts.length) throw new TypeError("ai usage operation: missing key parts");
  const normalized = parts.map((part) => String(part ?? "").trim().toLowerCase());
  if (normalized.some((part) => !/^[a-z0-9][a-z0-9_-]{0,47}$/u.test(part))) {
    throw new TypeError("ai usage operation: invalid key part");
  }
  const key = `worker:${safeScope}:${normalized.join(":")}`;
  if (!KEY.test(key)) throw new TypeError("ai usage operation: invalid scope");
  return key;
}

/**
 * Acquires one logical user operation under the same per-user row lock as web requests.
 * A committed key is a completed replay; a fresh reservation means another worker owns
 * it. Released/expired/stale rows are reused, preserving the unique operation key.
 */
export async function acquireWorkerAiUsage(pool, input) {
  const userId = positiveId(input?.userId, "ai usage user");
  const kind = String(input?.kind ?? "").trim().slice(0, 64);
  const key = String(input?.key ?? "").trim().toLowerCase();
  if (!kind) throw new TypeError("ai usage: kind required");
  if (!KEY.test(key)) throw new TypeError("ai usage: invalid reservation key");
  const limit = positiveInt(input?.limit, WORKER_AI_DAILY_LIMIT, 100_000);
  const ttlMs = positiveInt(input?.ttlMs, WORKER_AI_RESERVATION_TTL_MS, 60 * 60_000);
  const reclaimAfterMs = positiveInt(
    input?.reclaimAfterMs,
    Math.min(WORKER_AI_RECLAIM_AFTER_MS, ttlMs),
    ttlMs,
  );
  const cleanupBatch = positiveInt(input?.cleanupBatch, CLEANUP_BATCH, 1_000);

  const client = await pool.connect();
  try {
    await client.query("begin");
    const owner = await client.query(`select id from users where id = $1 for update`, [userId]);
    if (!owner.rowCount) throw new Error("ai usage: user not found");

    await client.query(
      `with stale as (
         select id from ai_usage
          where user_id = $1 and status = 'reserved' and expires_at <= now()
          order by expires_at, id
          limit $2
          for update skip locked
       )
       update ai_usage u
          set status = 'expired', finalized_at = now()
         from stale
        where u.id = stale.id`,
      [userId, cleanupBatch],
    );

    const existing = (
      await client.query(
        `select id, status,
                (status = 'reserved' and expires_at > now()
                 and reserved_at > now() - ($3::int * interval '1 millisecond')) as fresh
           from ai_usage
          where user_id = $1 and reservation_key = $2
          for update`,
        [userId, key, reclaimAfterMs],
      )
    ).rows[0];

    if (existing?.status === "committed") {
      await client.query("commit");
      return {
        state: "committed",
        reservationId: Number(existing.id),
        key,
        used: null,
        limit,
        expiresAt: null,
      };
    }
    if (existing?.status === "reserved" && existing.fresh === true) {
      await client.query("commit");
      return {
        state: "in_progress",
        reservationId: Number(existing.id),
        key,
        used: null,
        limit,
        expiresAt: null,
      };
    }

    const count = await client.query(
      `select count(*)::int as n
         from ai_usage
        where user_id = $1 and usage_date = current_date
          and id <> coalesce($2::bigint, 0)
          and (status = 'committed' or (status = 'reserved' and expires_at > now()))`,
      [userId, existing?.id ?? null],
    );
    const used = Number(count.rows[0]?.n ?? 0);
    if (used >= limit) {
      await client.query("rollback");
      return {
        state: "limit",
        reservationId: null,
        key,
        used,
        limit,
        expiresAt: null,
      };
    }

    const reserved = existing
      ? await client.query(
          `update ai_usage
              set kind = $3, status = 'reserved', usage_date = current_date,
                  reserved_at = now(), expires_at = now() + ($4::int * interval '1 millisecond'),
                  finalized_at = null
            where id = $1 and user_id = $2 and status in ('reserved', 'released', 'expired')
            returning id, expires_at`,
          [existing.id, userId, kind, ttlMs],
        )
      : await client.query(
          `insert into ai_usage
             (user_id, kind, status, reservation_key, reserved_at, expires_at)
           values ($1, $2, 'reserved', $3, now(), now() + ($4::int * interval '1 millisecond'))
           returning id, expires_at`,
          [userId, kind, key, ttlMs],
        );
    const reservationId = Number(reserved.rows[0]?.id);
    if (!Number.isSafeInteger(reservationId) || reservationId <= 0) {
      throw new Error("ai usage: reservation id missing");
    }
    await client.query("commit");
    const rawExpiry = reserved.rows[0]?.expires_at;
    return {
      state: "acquired",
      reservationId,
      key,
      used: used + 1,
      limit,
      expiresAt: rawExpiry instanceof Date ? rawExpiry.toISOString() : String(rawExpiry ?? ""),
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function finalizeWorkerAiUsage(db, userIdValue, reservationIdValue, target) {
  const userId = positiveId(userIdValue, "ai usage user");
  const reservationId = Number(reservationIdValue);
  if (!Number.isSafeInteger(reservationId) || reservationId <= 0) {
    return { changed: false, status: null };
  }
  if (target !== "committed" && target !== "released") throw new TypeError("ai usage: invalid final state");
  const updated = await db.query(
    `update ai_usage
        set status = case
                       when expires_at is null or expires_at <= now() then 'expired'
                       else $3
                     end,
            finalized_at = now()
      where id = $1 and user_id = $2 and status = 'reserved'
      returning status`,
    [reservationId, userId, target],
  );
  if (updated.rowCount) {
    const status = updated.rows[0]?.status ?? null;
    return { changed: status === target, status };
  }
  const current = await db.query(
    `select status from ai_usage where id = $1 and user_id = $2`,
    [reservationId, userId],
  );
  return { changed: false, status: current.rows[0]?.status ?? null };
}

export async function commitWorkerAiUsage(db, userId, reservationId) {
  return (await finalizeWorkerAiUsage(db, userId, reservationId, "committed")).changed;
}

export async function releaseWorkerAiUsage(db, userId, reservationId) {
  return (await finalizeWorkerAiUsage(db, userId, reservationId, "released")).changed;
}

/** Global bounded lease cleanup used by the cron worker; rows remain as audit history. */
export async function expireWorkerAiUsageReservations(db, limitValue = CLEANUP_BATCH) {
  const limit = positiveInt(limitValue, CLEANUP_BATCH, 1_000);
  const result = await db.query(
    `with stale as (
       select id from ai_usage
        where status = 'reserved' and expires_at <= now()
        order by expires_at, id
        limit $1
        for update skip locked
     )
     update ai_usage usage
        set status = 'expired', finalized_at = now()
       from stale
      where usage.id = stale.id`,
    [limit],
  );
  return result.rowCount ?? 0;
}

/** Refreshes the short lease. A dead worker stops heartbeating and can be reclaimed. */
export async function heartbeatWorkerAiUsage(db, userIdValue, reservationIdValue, ttlMsValue) {
  const userId = positiveId(userIdValue, "ai usage user");
  const reservationId = positiveId(reservationIdValue, "ai usage reservation");
  const ttlMs = positiveInt(ttlMsValue, WORKER_AI_RESERVATION_TTL_MS, 60 * 60_000);
  const result = await db.query(
    `update ai_usage
        set reserved_at = now(), expires_at = now() + ($3::int * interval '1 millisecond')
      where id = $1 and user_id = $2 and status = 'reserved' and expires_at > now()`,
    [reservationId, userId, ttlMs],
  );
  return Boolean(result.rowCount);
}
