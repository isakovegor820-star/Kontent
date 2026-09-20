import type { Pool, PoolClient } from "pg";

import { createPasswordResetOutboxRequest } from "./password-reset";

type Transactional = Pick<Pool, "query" | "connect">;

export type AdminAccountActionResult =
  | { status: "ok"; action: string; targetUserId: number }
  | { status: "not_found" }
  | { status: "self" }
  | { status: "protected" }
  | { status: "no_email" }
  | { status: "invalid_limit" }
  | { status: "already" };

export const ADMIN_AI_LIMIT_MAX = 100_000;

type BaseInput = {
  actorUserId: number;
  targetUserId: number;
  requestId?: string | null;
  /** Global admins cannot be blocked from the panel; the allowlist decides who they are. */
  isProtected?: (user: { id: number; email: string | null }) => boolean;
};

function positiveId(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

async function journal(
  db: Pick<Pool, "query">,
  input: BaseInput & { action: string; reason?: string | null; safeData?: Record<string, string | number | boolean | null> },
) {
  await db.query(
    `insert into admin_account_actions (actor_user_id, target_user_id, action, reason, safe_data, request_id)
     values ($1, $2, $3, $4, $5::jsonb, $6)`,
    [
      input.actorUserId,
      input.targetUserId,
      input.action,
      input.reason ? input.reason.slice(0, 500) : null,
      JSON.stringify(input.safeData ?? {}),
      input.requestId ?? null,
    ],
  );
}

async function lockTarget(client: Pick<Pool, "query">, targetUserId: number) {
  const result = await client.query<{ id: unknown; email: string | null; blocked_at: unknown; ai_daily_limit: unknown }>(
    `select id, email, blocked_at, ai_daily_limit from users where id = $1 for update`,
    [targetUserId],
  );
  return result.rows[0] ?? null;
}

async function withTransaction<T>(
  pool: Transactional,
  run: (client: Pick<PoolClient, "query">) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Blocking rotates the credential epoch so every live session dies in the same
 * transaction; the account, projects and content stay intact. Unblocking restores login
 * but does not resurrect old sessions.
 */
export async function setAdminAccountBlock(
  pool: Transactional,
  input: BaseInput & { blocked: boolean; reason?: string | null },
): Promise<AdminAccountActionResult> {
  if (input.actorUserId === input.targetUserId) return { status: "self" };
  return withTransaction(pool, async (client) => {
    const target = await lockTarget(client, input.targetUserId);
    if (!target) return { status: "not_found" };
    if (input.blocked && input.isProtected?.({ id: positiveId(target.id), email: target.email })) return { status: "protected" };
    const currentlyBlocked = target.blocked_at != null;
    if (currentlyBlocked === input.blocked) return { status: "already" };
    if (input.blocked) {
      await client.query(
        `update users
            set blocked_at = now(), blocked_reason = $2, credential_epoch = credential_epoch + 1
          where id = $1`,
        [input.targetUserId, input.reason ? input.reason.slice(0, 500) : null],
      );
      await client.query(`update sessions set expires_at = now() where user_id = $1 and expires_at > now()`, [input.targetUserId]);
    } else {
      await client.query(`update users set blocked_at = null, blocked_reason = null where id = $1`, [input.targetUserId]);
    }
    const action = input.blocked ? "account.blocked" : "account.unblocked";
    await journal(client, { ...input, action, reason: input.reason ?? null });
    return { status: "ok", action, targetUserId: input.targetUserId };
  });
}

/** Ends every session (epoch bump + expiry) without changing anything else on the account. */
export async function revokeAdminAccountSessions(
  pool: Transactional,
  input: BaseInput & { reason?: string | null },
): Promise<AdminAccountActionResult> {
  return withTransaction(pool, async (client) => {
    const target = await lockTarget(client, input.targetUserId);
    if (!target) return { status: "not_found" };
    await client.query(`update users set credential_epoch = credential_epoch + 1 where id = $1`, [input.targetUserId]);
    const revoked = await client.query(
      `update sessions set expires_at = now() where user_id = $1 and expires_at > now()`,
      [input.targetUserId],
    );
    await journal(client, {
      ...input,
      action: "account.sessions_revoked",
      reason: input.reason ?? null,
      safeData: { sessions: revoked.rowCount ?? 0, self: input.actorUserId === input.targetUserId },
    });
    return { status: "ok", action: "account.sessions_revoked", targetUserId: input.targetUserId };
  });
}

/** Sends the regular password-recovery email through the existing outbox; the admin never sees the token. */
export async function sendAdminPasswordReset(
  pool: Transactional,
  input: BaseInput,
): Promise<AdminAccountActionResult> {
  const target = await pool.query<{ email: string | null; blocked_at: unknown }>(
    `select email, blocked_at from users where id = $1`,
    [input.targetUserId],
  );
  const row = target.rows[0];
  if (!row) return { status: "not_found" };
  if (!row.email) return { status: "no_email" };
  const created = await createPasswordResetOutboxRequest(
    { email: row.email, requestIpHash: `admin:${input.actorUserId}` },
    pool,
  );
  if (!created) return { status: "not_found" };
  await journal(pool, {
    ...input,
    action: "account.password_reset_sent",
    safeData: { outboxId: created.outboxId, generation: created.generation },
  });
  return { status: "ok", action: "account.password_reset_sent", targetUserId: input.targetUserId };
}

/** `limit === null` removes the override and returns the account to the platform default. */
export async function setAdminAccountAiLimit(
  pool: Transactional,
  input: BaseInput & { limit: number | null; reason?: string | null },
): Promise<AdminAccountActionResult> {
  if (input.limit !== null && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > ADMIN_AI_LIMIT_MAX)) {
    return { status: "invalid_limit" };
  }
  return withTransaction(pool, async (client) => {
    const target = await lockTarget(client, input.targetUserId);
    if (!target) return { status: "not_found" };
    const previous = target.ai_daily_limit == null ? null : positiveId(target.ai_daily_limit);
    await client.query(`update users set ai_daily_limit = $2 where id = $1`, [input.targetUserId, input.limit]);
    await journal(client, {
      ...input,
      action: "account.ai_limit_changed",
      reason: input.reason ?? null,
      safeData: { from: previous, to: input.limit },
    });
    return { status: "ok", action: "account.ai_limit_changed", targetUserId: input.targetUserId };
  });
}
