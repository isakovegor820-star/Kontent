import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { hashPassword } from "./password";
import { encryptToken } from "./token-crypto.mjs";
import { deliverPasswordResetEmail } from "./password-reset-delivery.mjs";

export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1_000;

export function hashPasswordResetToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function passwordResetRateKey(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex");
}

export function createPasswordResetToken(now = new Date()) {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: hashPasswordResetToken(token),
    expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MS),
  };
}

export function passwordResetUrl(appUrl: string, token: string): string {
  const url = new URL("/reset-password", appUrl);
  // A fragment is not sent in HTTP requests/referrers or server access logs. Client JS
  // reads it and submits the token once in the POST body.
  url.hash = `token=${encodeURIComponent(token)}`;
  return url.toString();
}

export function configuredAppUrl(): string | null {
  const raw = String(process.env.APP_URL || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (process.env.NODE_ENV === "production" && url.protocol !== "https:") return null;
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export async function createPasswordResetOutboxRequest(
  input: { email: string; requestIpHash: string; now?: Date },
  pool: Pick<Pool, "connect">,
): Promise<{ outboxId: number; generation: number } | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const user = (await client.query<{ id: string; password_reset_generation: string }>(
      `select id, password_reset_generation from users where email = $1 for update`,
      [input.email],
    )).rows[0];
    if (!user) {
      await client.query("rollback");
      return null;
    }
    const generation = Number(user.password_reset_generation) + 1;
    await client.query(
      `update users set password_reset_generation = $2 where id = $1`,
      [user.id, generation],
    );
    await client.query(
      `update password_reset_tokens
          set used_at = coalesce(used_at, $2)
        where user_id = $1 and used_at is null`,
      [user.id, input.now ?? new Date()],
    );
    const created = createPasswordResetToken(input.now);
    const tokenRow = (await client.query<{ id: string }>(
      `insert into password_reset_tokens
         (user_id, token_hash, request_ip_hash, expires_at, generation)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [user.id, created.tokenHash, input.requestIpHash, created.expiresAt, generation],
    )).rows[0];
    const tokenEnvelope = encryptToken(created.token, {
      userId: Number(user.id),
      provider: "password-reset",
    });
    const outbox = (await client.query<{ id: string }>(
      `insert into password_reset_outbox
         (user_id, token_id, generation, recipient, token_envelope)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [user.id, tokenRow.id, generation, input.email, tokenEnvelope],
    )).rows[0];
    await client.query("commit");
    return { outboxId: Number(outbox.id), generation };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export interface PasswordResetDelivery {
  ok: boolean;
  code?: "not_configured" | "provider_error" | "network_error";
}

export async function sendPasswordResetEmail(
  input: { to: string; resetUrl: string; idempotencyKey: string },
  fetchImpl: typeof fetch = fetch,
): Promise<PasswordResetDelivery> {
  return deliverPasswordResetEmail(input, { fetchImpl });
}

export type PasswordResetConsumeResult = "ok" | "invalid" | "expired" | "used";

export async function consumePasswordReset(
  input: { token: string; password: string; now?: Date },
  pool: Pick<Pool, "connect">,
  hashPasswordFn: (password: string) => Promise<string> = hashPassword,
): Promise<PasswordResetConsumeResult> {
  const tokenHash = hashPasswordResetToken(input.token);
  const passwordHash = await hashPasswordFn(input.password);
  const now = input.now ?? new Date();
  const client = await pool.connect();
  try {
    await client.query("begin");
    const row = (
      await client.query<{
        id: string;
        user_id: string;
        generation: string;
        expires_at: string;
        used_at: string | null;
      }>(
        `select t.id, t.user_id, t.generation, t.expires_at, t.used_at
           from password_reset_tokens t
          where t.token_hash = $1
          for update of t`,
        [tokenHash],
      )
    ).rows[0];
    if (!row) {
      await client.query("rollback");
      return "invalid";
    }
    if (row.used_at) {
      await client.query("rollback");
      return "used";
    }
    if (new Date(row.expires_at).getTime() <= now.getTime()) {
      await client.query("rollback");
      return "expired";
    }
    const owner = (await client.query<{ password_reset_generation: string }>(
      `select password_reset_generation from users where id = $1 for update`,
      [row.user_id],
    )).rows[0];
    if (!owner || Number(owner.password_reset_generation) !== Number(row.generation)) {
      await client.query("rollback");
      return "used";
    }

    const used = await client.query(
      `update password_reset_tokens
          set used_at = $2
        where id = $1 and used_at is null`,
      [row.id, now],
    );
    if ((used.rowCount ?? 0) !== 1) {
      await client.query("rollback");
      return "used";
    }
    await client.query(
      `update users
          set password_hash = $2, credential_epoch = credential_epoch + 1
        where id = $1 and password_reset_generation = $3`, [
      row.user_id,
      passwordHash,
      Number(row.generation),
    ]);
    await client.query(`delete from sessions where user_id = $1`, [row.user_id]);
    await client.query("commit");
    return "ok";
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
