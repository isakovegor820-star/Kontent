// Учёт генераций ИИ и дневной лимит (ТЗ Д.8, ТЗ 12 — честный лимит с видимым счётчиком).
// Лимит на пользователя в сутки. Для локального движка он щедрый, но механика та же,
// что и для платного облака — сменим движок, не трогая продукт.

import { getPool } from "./db";
import type { Pool } from "pg";
import { createHash, randomUUID } from "node:crypto";
import {
  profileFieldsFromStoredText,
  selectEffectiveProfile,
  type EffectiveProfile,
  type ProfileCandidate,
} from "./effective-ai-context";

export const AI_DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT || 30);
const configuredReservationTtl = Number(process.env.AI_RESERVATION_TTL_MS || 10 * 60_000);
export const AI_RESERVATION_TTL_MS = Number.isFinite(configuredReservationTtl)
  ? Math.min(60 * 60_000, Math.max(1_000, Math.round(configuredReservationTtl)))
  : 10 * 60_000;
const RESERVATION_CLEANUP_BATCH = 100;

export type AiUsageStatus = "reserved" | "committed" | "released" | "expired";

export type AiUsageRequestState =
  | "missing"
  | "acquired"
  | "in_progress"
  | "terminal_pending_ack"
  | "replay"
  | "released"
  | "expired"
  | "conflict"
  | "committed_without_result"
  | "limit";

export interface AiUsageStoredResult {
  protocol: "ndjson" | "text";
  text: string;
  pipeline: "single" | "editorial" | "draft-fallback";
  requestedEngine: string;
  engine: string;
  fallbackUsed: boolean;
  validation?: {
    status: "passed" | "blocked" | "not_checked";
    requiresReview: boolean;
    provenance: Record<string, unknown>;
    blockerCodes: string[];
  };
}

export interface AiUsageRequestLookup {
  state: AiUsageRequestState;
  reservationId: number | null;
  result: AiUsageStoredResult | null;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

/** Stable request-body fingerprint; the body itself is never written to logs. */
export function aiRequestFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function storedResult(value: unknown): AiUsageStoredResult | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const result = candidate as Partial<AiUsageStoredResult>;
  if (
    (result.protocol !== "ndjson" && result.protocol !== "text")
    || typeof result.text !== "string"
    || !["single", "editorial", "draft-fallback"].includes(String(result.pipeline))
    || typeof result.requestedEngine !== "string"
    || typeof result.engine !== "string"
    || typeof result.fallbackUsed !== "boolean"
  ) return null;
  return result as AiUsageStoredResult;
}

/** Сколько генераций пользователь потратил сегодня. */
export async function aiUsedToday(userId: number): Promise<number> {
  const r = await getPool().query<{ n: number }>(
    `select count(*)::int as n
       from ai_usage
      where user_id = $1 and usage_date = current_date
        and (status = 'committed' or (status = 'reserved' and expires_at > now()))`,
    [userId],
  );
  return r.rows[0]?.n ?? 0;
}

/**
 * Legacy/internal direct commit. It bypasses the reservation gate but still contributes
 * to the user's daily counter, so interactive code must not call it.
 * @deprecated Interactive flows must use reserveAiUsage + commit/release.
 */
export async function recordAiUsage(userId: number, kind: string): Promise<void> {
  await getPool().query(
    `insert into ai_usage (user_id, kind, status, finalized_at)
     values ($1, $2, 'committed', now())`,
    [userId, kind],
  );
}

export interface AiUsageReservation {
  allowed: boolean;
  used: number;
  limit: number;
  reservationId: number | null;
  reservationKey: string | null;
  status: "reserved" | null;
  expiresAt: string | null;
  requestState?: AiUsageRequestState;
  result?: AiUsageStoredResult | null;
}

export interface AiUsageReservationOptions {
  limit?: number;
  reservationKey?: string;
  ttlMs?: number;
  cleanupBatch?: number;
}

export interface AiUsageRequestOptions extends AiUsageReservationOptions {
  reservationKey: string;
  fingerprint: string;
  operationId: string;
}

function safePositiveInt(value: number | undefined, fallback: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(1, Math.round(Number(value)))) : fallback;
}

function reservationKey(value?: string): string {
  const clean = String(value ?? "").trim();
  return /^[A-Za-z0-9:_-]{8,128}$/u.test(clean) ? clean : randomUUID();
}

function validFingerprint(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function validOperationId(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value);
}

/**
 * Read-only replay probe. It deliberately does not reserve quota, so callers can check a
 * completed request before provider health while still checking health before a new paid call.
 */
export async function lookupAiUsageRequest(
  userId: number,
  keyValue: string,
  fingerprint: string,
  pool: Pick<Pool, "query"> = getPool(),
): Promise<AiUsageRequestLookup> {
  const key = reservationKey(keyValue);
  if (key !== keyValue || !validFingerprint(fingerprint)) {
    return { state: "conflict", reservationId: null, result: null };
  }
  const row = (
    await pool.query<{
      id: string;
      status: AiUsageStatus;
      request_fingerprint: string | null;
      result_payload: unknown;
      fresh: boolean;
    }>(
      `select id, status, request_fingerprint, result_payload,
              (status = 'reserved' and expires_at > now()) as fresh
         from ai_usage
        where user_id = $1 and reservation_key = $2`,
      [userId, key],
    )
  ).rows[0];
  if (!row) return { state: "missing", reservationId: null, result: null };
  const reservationId = Number(row.id);
  if (row.request_fingerprint && row.request_fingerprint !== fingerprint) {
    return { state: "conflict", reservationId, result: null };
  }
  if (row.status === "committed") {
    const result = storedResult(row.result_payload);
    return {
      state: result ? "replay" : "committed_without_result",
      reservationId,
      result,
    };
  }
  if (row.status === "reserved" && row.fresh) {
    const result = storedResult(row.result_payload);
    return {
      state: result ? "terminal_pending_ack" : "in_progress",
      reservationId,
      result,
    };
  }
  return {
    state: row.status === "released" ? "released" : "expired",
    reservationId,
    result: null,
  };
}

/**
 * Acquires one web generation by stable idempotency key. Committed requests replay their
 * durable terminal result; released/expired requests reuse the same audit row and quota key.
 */
export async function acquireAiUsageRequest(
  userId: number,
  kind: string,
  options: AiUsageRequestOptions,
  pool: Pick<Pool, "connect"> = getPool(),
): Promise<AiUsageReservation> {
  const limit = safePositiveInt(options.limit, AI_DAILY_LIMIT, 100_000);
  const ttlMs = safePositiveInt(options.ttlMs, AI_RESERVATION_TTL_MS, 60 * 60_000);
  const cleanupBatch = safePositiveInt(options.cleanupBatch, RESERVATION_CLEANUP_BATCH, 1_000);
  const key = reservationKey(options.reservationKey);
  if (key !== options.reservationKey || !validFingerprint(options.fingerprint)) {
    throw new TypeError("ai usage: invalid request identity");
  }
  if (!validOperationId(options.operationId)) throw new TypeError("ai usage: invalid operation id");

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
          set status = 'expired', finalized_at = now(),
              result_payload = null, result_content_type = null
         from stale
        where u.id = stale.id`,
      [userId, cleanupBatch],
    );

    const existing = (
      await client.query<{
        id: string;
        status: AiUsageStatus;
        request_fingerprint: string | null;
        result_payload: unknown;
        fresh: boolean;
      }>(
        `select id, status, request_fingerprint, result_payload,
                (status = 'reserved' and expires_at > now()) as fresh
           from ai_usage
          where user_id = $1 and reservation_key = $2
          for update`,
        [userId, key],
      )
    ).rows[0];
    const existingId = existing ? Number(existing.id) : null;
    if (existing?.request_fingerprint && existing.request_fingerprint !== options.fingerprint) {
      await client.query("commit");
      return {
        allowed: false,
        used: 0,
        limit,
        reservationId: existingId,
        reservationKey: key,
        status: null,
        expiresAt: null,
        requestState: "conflict",
        result: null,
      };
    }
    if (existing?.status === "committed") {
      const result = storedResult(existing.result_payload);
      await client.query("commit");
      return {
        allowed: false,
        used: 0,
        limit,
        reservationId: existingId,
        reservationKey: key,
        status: null,
        expiresAt: null,
        requestState: result ? "replay" : "committed_without_result",
        result,
      };
    }
    if (existing?.status === "reserved" && existing.fresh) {
      const result = storedResult(existing.result_payload);
      await client.query("commit");
      return {
        allowed: false,
        used: 0,
        limit,
        reservationId: existingId,
        reservationKey: key,
        status: null,
        expiresAt: null,
        requestState: result ? "terminal_pending_ack" : "in_progress",
        result,
      };
    }

    const count = await client.query<{ n: number }>(
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
        allowed: false,
        used,
        limit,
        reservationId: null,
        reservationKey: key,
        status: null,
        expiresAt: null,
        requestState: "limit",
        result: null,
      };
    }

    const reserved = existing
      ? await client.query<{ id: string; expires_at: Date | string }>(
          `update ai_usage
              set kind = $3, status = 'reserved', usage_date = current_date,
                  reserved_at = now(), expires_at = now() + ($4::int * interval '1 millisecond'),
                  finalized_at = null, request_fingerprint = $5, operation_id = $6::uuid,
                  result_payload = null, result_content_type = null
            where id = $1 and user_id = $2 and status in ('reserved', 'released', 'expired')
            returning id, expires_at`,
          [existing.id, userId, kind, ttlMs, options.fingerprint, options.operationId],
        )
      : await client.query<{ id: string; expires_at: Date | string }>(
          `insert into ai_usage (
             user_id, kind, status, reservation_key, reserved_at, expires_at,
             request_fingerprint, operation_id
           ) values (
             $1, $2, 'reserved', $3, now(), now() + ($4::int * interval '1 millisecond'),
             $5, $6::uuid
           )
           returning id, expires_at`,
          [userId, kind, key, ttlMs, options.fingerprint, options.operationId],
        );
    const reservationId = Number(reserved.rows[0]?.id);
    if (!Number.isSafeInteger(reservationId) || reservationId <= 0) {
      throw new Error("ai usage: reservation id missing");
    }
    await client.query("commit");
    const rawExpiry = reserved.rows[0]?.expires_at;
    return {
      allowed: true,
      used: used + 1,
      limit,
      reservationId,
      reservationKey: key,
      status: "reserved",
      expiresAt: rawExpiry instanceof Date ? rawExpiry.toISOString() : String(rawExpiry ?? ""),
      requestState: "acquired",
      result: null,
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Атомарно занимает одну генерацию до обращения к платному провайдеру. Блокируем строку
 * пользователя внутри транзакции: параллельные запросы одного аккаунта выстраиваются в
 * очередь, а разные аккаунты друг другу не мешают. ai_usage остаётся журналом фактических
 * запросов и источником счётчика для существующего UI.
 */
export async function reserveAiUsage(
  userId: number,
  kind: string,
  options: AiUsageReservationOptions = {},
  pool: Pick<Pool, "connect"> = getPool(),
): Promise<AiUsageReservation> {
  const limit = safePositiveInt(options.limit, AI_DAILY_LIMIT, 100_000);
  const ttlMs = safePositiveInt(options.ttlMs, AI_RESERVATION_TTL_MS, 60 * 60_000);
  const cleanupBatch = safePositiveInt(options.cleanupBatch, RESERVATION_CLEANUP_BATCH, 1_000);
  const key = reservationKey(options.reservationKey);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const owner = await client.query(`select id from users where id = $1 for update`, [userId]);
    if (owner.rowCount === 0) throw new Error("ai usage: user not found");

    // Bounded cleanup под тем же user lock: старый crashed request не занимает дневной
    // слот, но остаётся в audit trail со статусом expired.
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

    const count = await client.query<{ n: number }>(
      `select count(*)::int as n
         from ai_usage
        where user_id = $1 and usage_date = current_date
          and (status = 'committed' or (status = 'reserved' and expires_at > now()))`,
      [userId],
    );
    const used = count.rows[0]?.n ?? 0;
    if (used >= limit) {
      await client.query("rollback");
      return {
        allowed: false,
        used,
        limit,
        reservationId: null,
        reservationKey: null,
        status: null,
        expiresAt: null,
      };
    }

    const inserted = await client.query<{ id: string; expires_at: Date | string }>(
      `insert into ai_usage (
         user_id, kind, status, reservation_key, reserved_at, expires_at
       ) values (
         $1, $2, 'reserved', $3, now(), now() + ($4::int * interval '1 millisecond')
       )
       returning id, expires_at`,
      [userId, kind, key, ttlMs],
    );
    const reservationId = Number(inserted.rows[0]?.id);
    if (!Number.isSafeInteger(reservationId) || reservationId <= 0) {
      throw new Error("ai usage: reservation id missing");
    }
    await client.query("commit");
    const rawExpiry = inserted.rows[0]?.expires_at;
    const expiresAt = rawExpiry instanceof Date ? rawExpiry.toISOString() : String(rawExpiry ?? "");
    return {
      allowed: true,
      used: used + 1,
      limit,
      reservationId,
      reservationKey: key,
      status: "reserved",
      expiresAt,
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export interface AiUsageFinalization {
  changed: boolean;
  status: AiUsageStatus | null;
}

export interface AiUsageResultFinalization extends AiUsageFinalization {
  result: AiUsageStoredResult | null;
}

/**
 * Persists a validated result while keeping quota in the reserved state. The NDJSON
 * `done` event may only be emitted after this succeeds; quota is committed separately
 * by an authenticated client acknowledgement after it receives that terminal event.
 */
export async function stageAiUsageResult(
  userId: number,
  reservationId: number | null,
  operationId: string,
  result: AiUsageStoredResult,
  pool: Pick<Pool, "query"> = getPool(),
): Promise<AiUsageResultFinalization> {
  if (
    !Number.isSafeInteger(reservationId)
    || Number(reservationId) <= 0
    || !validOperationId(operationId)
  ) {
    return { changed: false, status: null, result: null };
  }
  const serialized = JSON.stringify(result);
  const updated = await pool.query<{ status: AiUsageStatus; result_payload: unknown }>(
    `update ai_usage
        set status = case
                       when expires_at is null or expires_at <= now() then 'expired'
                       else 'reserved'
                     end,
            result_payload = case
                               when expires_at is not null and expires_at > now() then $4::jsonb
                               else null
                             end,
            result_content_type = case
                                    when expires_at is not null and expires_at > now() then $5
                                    else null
                                  end,
            finalized_at = case
                             when expires_at is null or expires_at <= now() then now()
                             else finalized_at
                           end
      where id = $1 and user_id = $2 and operation_id = $3::uuid and status = 'reserved'
      returning status, result_payload`,
    [reservationId, userId, operationId, serialized, result.protocol],
  );
  if ((updated.rowCount ?? 0) > 0) {
    const status = updated.rows[0]?.status ?? null;
    return {
      changed: status === "reserved" && Boolean(storedResult(updated.rows[0]?.result_payload)),
      status,
      result: storedResult(updated.rows[0]?.result_payload),
    };
  }
  const current = await pool.query<{ status: AiUsageStatus; result_payload: unknown }>(
    `select status, result_payload
       from ai_usage
      where id = $1 and user_id = $2 and operation_id = $3::uuid`,
    [reservationId, userId, operationId],
  );
  return {
    changed: false,
    status: current.rows[0]?.status ?? null,
    result: storedResult(current.rows[0]?.result_payload),
  };
}

/**
 * Idempotent second phase: only a staged result for this authenticated user's stable
 * reservation key can consume quota. Repeated ACKs return the already committed result.
 */
export async function acknowledgeAiUsageResult(
  userId: number,
  keyValue: string,
  pool: Pick<Pool, "query"> = getPool(),
): Promise<AiUsageResultFinalization> {
  const key = reservationKey(keyValue);
  if (key !== keyValue) return { changed: false, status: null, result: null };
  const updated = await pool.query<{ status: AiUsageStatus; result_payload: unknown }>(
    `update ai_usage
        set status = case
                       when expires_at is null or expires_at <= now() then 'expired'
                       else 'committed'
                     end,
            result_payload = case
                               when expires_at is not null and expires_at > now() then result_payload
                               else null
                             end,
            result_content_type = case
                                    when expires_at is not null and expires_at > now() then result_content_type
                                    else null
                                  end,
            finalized_at = now()
      where user_id = $1 and reservation_key = $2
        and status = 'reserved' and result_payload is not null
      returning status, result_payload`,
    [userId, key],
  );
  if ((updated.rowCount ?? 0) > 0) {
    const status = updated.rows[0]?.status ?? null;
    return {
      changed: status === "committed",
      status,
      result: storedResult(updated.rows[0]?.result_payload),
    };
  }
  const current = await pool.query<{ status: AiUsageStatus; result_payload: unknown }>(
    `select status, result_payload
       from ai_usage
      where user_id = $1 and reservation_key = $2`,
    [userId, key],
  );
  return {
    changed: false,
    status: current.rows[0]?.status ?? null,
    result: storedResult(current.rows[0]?.result_payload),
  };
}

/**
 * Persists the validated terminal result and charges quota in one conditional statement.
 * If HTTP delivery of `done` is lost afterwards, the same idempotency key can replay this
 * exact result instead of invoking the provider or charging again.
 */
export async function commitAiUsageResult(
  userId: number,
  reservationId: number | null,
  operationId: string,
  result: AiUsageStoredResult,
  pool: Pick<Pool, "query"> = getPool(),
): Promise<AiUsageResultFinalization> {
  if (
    !Number.isSafeInteger(reservationId)
    || Number(reservationId) <= 0
    || !validOperationId(operationId)
  ) {
    return { changed: false, status: null, result: null };
  }
  const serialized = JSON.stringify(result);
  const updated = await pool.query<{ status: AiUsageStatus; result_payload: unknown }>(
    `update ai_usage
        set status = case
                       when expires_at is null or expires_at <= now() then 'expired'
                       else 'committed'
                     end,
            result_payload = case
                               when expires_at is not null and expires_at > now() then $4::jsonb
                               else null
                             end,
            result_content_type = case
                                    when expires_at is not null and expires_at > now() then $5
                                    else null
                                  end,
            finalized_at = now()
      where id = $1 and user_id = $2 and operation_id = $3::uuid and status = 'reserved'
      returning status, result_payload`,
    [reservationId, userId, operationId, serialized, result.protocol],
  );
  if ((updated.rowCount ?? 0) > 0) {
    const status = updated.rows[0]?.status ?? null;
    return {
      changed: status === "committed",
      status,
      result: storedResult(updated.rows[0]?.result_payload),
    };
  }
  const current = await pool.query<{ status: AiUsageStatus; result_payload: unknown }>(
    `select status, result_payload
       from ai_usage
      where id = $1 and user_id = $2 and operation_id = $3::uuid`,
    [reservationId, userId, operationId],
  );
  return {
    changed: false,
    status: current.rows[0]?.status ?? null,
    result: storedResult(current.rows[0]?.result_payload),
  };
}

/**
 * Releases only the exact web-generation attempt that acquired the reservation. A retry
 * can reuse an expired row with a new operation ID; a late cleanup from the old provider
 * call must never release that newer attempt.
 */
export async function releaseAiUsageRequest(
  userId: number,
  reservationId: number | null,
  operationId: string,
  pool: Pick<Pool, "query"> = getPool(),
): Promise<boolean> {
  if (
    !Number.isSafeInteger(reservationId)
    || Number(reservationId) <= 0
    || !validOperationId(operationId)
  ) return false;
  const updated = await pool.query<{ status: AiUsageStatus }>(
    `update ai_usage
        set status = case
                       when expires_at is null or expires_at <= now() then 'expired'
                       else 'released'
                     end,
            finalized_at = now(),
            result_payload = null,
            result_content_type = null
      where id = $1 and user_id = $2 and operation_id = $3::uuid and status = 'reserved'
      returning status`,
    [reservationId, userId, operationId],
  );
  return updated.rows[0]?.status === "released";
}

/** Conditional transition делает конкурирующие commit/release exactly-once. */
export async function finalizeAiUsage(
  userId: number,
  reservationId: number | null,
  target: "committed" | "released",
  pool: Pick<Pool, "query"> = getPool(),
): Promise<AiUsageFinalization> {
  if (!Number.isSafeInteger(reservationId) || Number(reservationId) <= 0) {
    return { changed: false, status: null };
  }
  const updated = await pool.query<{ status: AiUsageStatus }>(
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
  if ((updated.rowCount ?? 0) > 0) {
    const status = updated.rows[0]?.status ?? null;
    return { changed: status === target, status };
  }
  const current = await pool.query<{ status: AiUsageStatus }>(
    `select status from ai_usage where id = $1 and user_id = $2`,
    [reservationId, userId],
  );
  return { changed: false, status: current.rows[0]?.status ?? null };
}

export async function commitAiUsage(
  userId: number,
  reservationId: number | null,
  pool: Pick<Pool, "query"> = getPool(),
): Promise<boolean> {
  return (await finalizeAiUsage(userId, reservationId, "committed", pool)).changed;
}

export async function releaseAiUsage(
  userId: number,
  reservationId: number | null,
  pool: Pick<Pool, "query"> = getPool(),
): Promise<boolean> {
  return (await finalizeAiUsage(userId, reservationId, "released", pool)).changed;
}

/** Глобальная bounded уборка для readiness/cron; строки не удаляются, audit сохраняется. */
export async function expireAiUsageReservations(
  limit = RESERVATION_CLEANUP_BATCH,
  pool: Pick<Pool, "query"> = getPool(),
): Promise<number> {
  const safeLimit = safePositiveInt(limit, RESERVATION_CLEANUP_BATCH, 1_000);
  const expired = await pool.query(
    `with stale as (
       select id from ai_usage
        where status = 'reserved' and expires_at <= now()
        order by expires_at, id
        limit $1
        for update skip locked
     )
     update ai_usage u
        set status = 'expired', finalized_at = now(),
            result_payload = null, result_content_type = null
       from stale
      where u.id = stale.id`,
    [safeLimit],
  );
  return expired.rowCount ?? 0;
}

/** Последние посты выбранного канала как образец стиля для ИИ (ТЗ Д.8: 5–10 постов). */
export async function styleSamplesFor(
  userId: number,
  channelId?: number | null,
  limit = 10,
  pool: Pick<Pool, "query"> = getPool(),
): Promise<string[]> {
  // No channel means no trustworthy voice boundary. Mixing samples across two brands is
  // worse than generating without style memory, so this path deliberately fails closed.
  if (channelId == null) return [];
  const safeLimit = Math.min(200, Math.max(1, Math.round(limit)));
  const r = await pool.query<{ text: string }>(
    `select text from posts
      where user_id = $1
        and channel_id = $2
        and status = 'published'
        and verification_state = 'verified'
        and length(trim(text)) > 0
        and not exists (select 1 from rss_items where rss_items.post_id = posts.id)
      order by published_at desc nulls last
      limit $3`,
    [userId, channelId ?? null, safeLimit],
  );
  return r.rows.map((x) => x.text);
}

export interface ChannelAiContext {
  id: number;
  title: string;
  network: string;
  profile: string;
  profileProvenance: EffectiveProfile;
  facts: string[];
  styleSamples: string[];
}

/**
 * Контекст именно выбранного канала. Чужой/отключённый id не подменяем первым попавшимся:
 * это защита от смешивания голосов двух брендов в одном аккаунте.
 */
export async function channelAiContextFor(
  userId: number,
  wantedChannelId?: number | null,
  styleLimit = 10,
  pool: Pick<Pool, "query"> = getPool(),
): Promise<ChannelAiContext | null> {
  const channel = wantedChannelId
    ? (
        await pool.query<{ id: string; title: string | null; handle: string | null; network: string }>(
          `select id, title, handle, network
             from channels
            where id = $1 and user_id = $2 and is_active = true`,
          [wantedChannelId, userId],
        )
      ).rows[0]
    : (
        await pool.query<{ id: string; title: string | null; handle: string | null; network: string }>(
          `select id, title, handle, network
             from channels
            where user_id = $1 and is_active = true
            order by id
            limit 1`,
          [userId],
        )
      ).rows[0];

  if (!channel) return null;
  const channelId = Number(channel.id);
  const profileRows = (
    await pool.query<{
      id: string;
      kind: "profile" | "profile_edit";
      raw_text: string;
      status: "pending" | "ready" | "error";
      added_at: Date | string;
    }>(
      `select id, kind, raw_text, status, added_at
         from knowledge_sources
        where user_id = $1 and channel_id = $2 and kind in ('profile_edit', 'profile')
        order by added_at desc
        limit 20`,
      [userId, channelId],
    )
  ).rows;
  const brief = (
    await pool.query<{
      niche: string | null;
      audience: string | null;
      rubrics: string[] | null;
      formats: string[] | null;
      author_role: string | null;
      goal: string | null;
      taboo: string | null;
      ready: boolean;
      updated_at: Date | string;
    }>(
      `select niche, audience, rubrics, formats, author_role, goal, taboo, ready, updated_at
         from content_brief
        where user_id = $1 and channel_id = $2`,
      [userId, channelId],
    )
  ).rows[0];
  const candidates: ProfileCandidate[] = profileRows.map((row) => ({
    id: `knowledge-${row.id}`,
    kind: row.kind,
    fields: profileFieldsFromStoredText(row.raw_text),
    // `profile_edit` is created only by the authenticated explicit PUT confirmation;
    // `profile` is automatic extraction and remains unverified. Field validation below
    // still rejects legacy junk before it can outrank the confirmed brief.
    verified: row.kind === "profile_edit",
    ready: row.status !== "error",
    updatedAt: new Date(row.added_at).toISOString(),
  }));
  if (brief) {
    candidates.push({
      id: "content-brief",
      kind: "verified_brief",
      fields: {
        niche: brief.niche ?? "",
        audience: brief.audience ?? "",
        topics: brief.rubrics?.join(", ") ?? "",
        goal: brief.goal ?? "",
        taboos: brief.taboo ?? "",
      },
      verified: brief.ready,
      ready: brief.ready,
      updatedAt: new Date(brief.updated_at).toISOString(),
    });
  }
  const effectiveProfile = selectEffectiveProfile(candidates);
  const profileLabels: Record<keyof EffectiveProfile, string> = {
    niche: "Ниша канала",
    topics: "Основные темы канала",
    services: "Услуги и продукты",
    prices: "Цены и сроки",
    audience: "Аудитория канала",
    tone: "Тон общения автора",
    taboos: "Табу",
    goal: "Цель канала",
  };
  const profileLines = Object.entries(effectiveProfile)
    .map(([field, selected]) => `${profileLabels[field as keyof EffectiveProfile]}: ${selected?.value}`)
    .filter((line) => !line.endsWith(": undefined"));
  if (brief?.formats?.length) profileLines.push(`Форматы публикаций: ${brief.formats.join(", ")}`);
  if (brief?.author_role?.trim()) profileLines.push(`Роль автора: ${brief.author_role.trim()}`);
  const profile = profileLines.join("\n\n");
  const facts = (
    await pool.query<{ raw_text: string }>(
      `select raw_text
         from knowledge_sources
        where user_id = $1 and channel_id = $2 and kind in ('form', 'paste') and status = 'ready'
        order by added_at desc
        limit 4`,
      [userId, channelId],
    )
  ).rows.map((row) => row.raw_text.trim()).filter(Boolean);

  return {
    id: channelId,
    title: channel.title || channel.handle || `Канал ${channelId}`,
    network: channel.network,
    profile: profile.trim().slice(0, 5000),
    profileProvenance: effectiveProfile,
    facts: facts.map((fact) => fact.slice(0, 3000)),
    styleSamples: await styleSamplesFor(userId, channelId, styleLimit, pool),
  };
}
