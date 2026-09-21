import { createHash, randomBytes } from "node:crypto";

import type { Pool } from "pg";

import { encryptToken } from "./token-crypto.mjs";

export const EMAIL_CHANGE_TTL_MS = 60 * 60 * 1_000;

export function hashEmailChangeToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function emailChangeFingerprint(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex");
}

export function emailChangeRateKey(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase(), "utf8").digest("hex");
}

export function createEmailChangeToken(now = new Date()) {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: hashEmailChangeToken(token),
    expiresAt: new Date(now.getTime() + EMAIL_CHANGE_TTL_MS),
  };
}

export function emailChangeUrl(appUrl: string, token: string): string {
  const url = new URL("/confirm-email", appUrl);
  // The fragment is never sent in HTTP request lines or referrers. The confirmation
  // page removes it before submitting the one-time token in a POST body.
  url.hash = `token=${encodeURIComponent(token)}`;
  return url.toString();
}

export type CreateEmailChangeResult =
  | { status: "created" | "replayed"; requestId: number; expiresAt: Date; targetEmail: string }
  | { status: "conflict" };

export async function createEmailChangeOutboxRequest(
  input: {
    userId: number;
    targetEmail: string;
    requestKey: string;
    now?: Date;
  },
  pool: Pick<Pool, "connect">,
): Promise<CreateEmailChangeResult> {
  const targetEmail = input.targetEmail.trim().toLowerCase();
  const fingerprint = emailChangeFingerprint(targetEmail);
  const now = input.now ?? new Date();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`select pg_advisory_xact_lock($1::bigint)`, [input.userId]);
    const existing = (
      await client.query<{
        id: string;
        request_fingerprint: string;
        target_email: string;
        expires_at: Date | string;
      }>(
        `select id, request_fingerprint, target_email, expires_at
           from email_change_requests
          where user_id = $1 and request_key = $2`,
        [input.userId, input.requestKey],
      )
    ).rows[0];
    if (existing) {
      await client.query("rollback");
      if (existing.request_fingerprint !== fingerprint) return { status: "conflict" };
      return {
        status: "replayed",
        requestId: Number(existing.id),
        expiresAt: new Date(existing.expires_at),
        targetEmail: existing.target_email,
      };
    }

    const owner = (
      await client.query<{ email_change_generation: string }>(
        `select email_change_generation from users where id = $1 for update`,
        [input.userId],
      )
    ).rows[0];
    if (!owner) throw new Error("email_change_user_missing");
    const generation = Number(owner.email_change_generation) + 1;
    await client.query(
      `update users set email_change_generation = $2 where id = $1`,
      [input.userId, generation],
    );
    await client.query(
      `update email_change_requests
          set cancelled_at = coalesce(cancelled_at, $2), updated_at = now()
        where user_id = $1 and confirmed_at is null and cancelled_at is null`,
      [input.userId, now],
    );
    await client.query(
      `update email_change_outbox
          set status = 'cancelled', last_error_code = 'request_superseded', updated_at = now()
        where user_id = $1 and status in ('pending','failed')`,
      [input.userId],
    );

    const created = createEmailChangeToken(now);
    const request = (
      await client.query<{ id: string }>(
        `insert into email_change_requests
           (user_id, request_key, request_fingerprint, target_email, token_hash,
            generation, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id`,
        [
          input.userId,
          input.requestKey,
          fingerprint,
          targetEmail,
          created.tokenHash,
          generation,
          created.expiresAt,
        ],
      )
    ).rows[0];
    const tokenEnvelope = encryptToken(created.token, {
      userId: input.userId,
      provider: "email-change",
    });
    await client.query(
      `insert into email_change_outbox
         (user_id, request_id, generation, recipient, token_envelope)
       values ($1, $2, $3, $4, $5)`,
      [input.userId, request.id, generation, targetEmail, tokenEnvelope],
    );
    await client.query("commit");
    return {
      status: "created",
      requestId: Number(request.id),
      expiresAt: created.expiresAt,
      targetEmail,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export type ConsumeEmailChangeResult = "ok" | "already_confirmed" | "invalid" | "expired" | "used" | "email_taken";

export async function consumeEmailChange(
  input: { token: string; currentSessionTokenHash?: string | null; now?: Date },
  pool: Pick<Pool, "connect">,
): Promise<ConsumeEmailChangeResult> {
  const tokenHash = hashEmailChangeToken(input.token);
  const now = input.now ?? new Date();
  const client = await pool.connect();
  try {
    await client.query("begin");
    const request = (
      await client.query<{
        id: string;
        user_id: string;
        target_email: string;
        generation: string;
        expires_at: Date | string;
        confirmed_at: Date | string | null;
        cancelled_at: Date | string | null;
        email_change_generation: string;
      }>(
        `select r.id, r.user_id, r.target_email, r.generation, r.expires_at,
                r.confirmed_at, r.cancelled_at, u.email_change_generation
           from email_change_requests r
           join users u on u.id = r.user_id
          where r.token_hash = $1
          for update of r, u`,
        [tokenHash],
      )
    ).rows[0];
    if (!request) {
      await client.query("rollback");
      return "invalid";
    }
    if (request.confirmed_at) {
      await client.query("rollback");
      return "already_confirmed";
    }
    if (request.cancelled_at || Number(request.generation) !== Number(request.email_change_generation)) {
      await client.query("rollback");
      return "used";
    }
    if (new Date(request.expires_at).getTime() <= now.getTime()) {
      await client.query(
        `update email_change_requests set cancelled_at = $2, updated_at = now() where id = $1`,
        [request.id, now],
      );
      await client.query("commit");
      return "expired";
    }

    try {
      // Email participates in authentication and in the global admin allowlist. Rotate
      // the credential epoch in the same transaction; all other sessions are revoked and
      // only the verifier presented by this confirmation may move to the new epoch.
      const updatedUser = await client.query<{ credential_epoch: string }>(
        `update users
            set email = $2, credential_epoch = credential_epoch + 1
          where id = $1
          returning credential_epoch`,
        [request.user_id, request.target_email],
      );
      const credentialEpoch = Number(updatedUser.rows[0]?.credential_epoch);
      if (!Number.isSafeInteger(credentialEpoch) || credentialEpoch < 0) {
        throw new Error("email_change_credential_epoch_missing");
      }

      const currentSessionTokenHash = input.currentSessionTokenHash || null;
      let preservedSessionTokenHash: string | null = null;
      if (currentSessionTokenHash) {
        // Keeping the current row is not enough: the epoch bump would otherwise make it
        // unusable. Move it only when it is live and belonged to the immediately previous
        // epoch; a stale/revoked verifier must never be revived by an email-change token.
        const updatedSession = await client.query(
          `update sessions
              set credential_epoch = $3
            where user_id = $1 and token_hash = $2
              and credential_epoch = $3::bigint - 1
              and expires_at > $4`,
          [request.user_id, currentSessionTokenHash, credentialEpoch, now],
        );
        if (updatedSession.rowCount === 1) preservedSessionTokenHash = currentSessionTokenHash;
      }
      await client.query(
        `delete from sessions
          where user_id = $1
            and ($2::text is null or token_hash <> $2)`,
        [request.user_id, preservedSessionTokenHash],
      );
    } catch (error) {
      if ((error as { code?: unknown })?.code === "23505") {
        await client.query("rollback").catch(() => undefined);
        return "email_taken";
      }
      throw error;
    }
    await client.query(
      `update email_change_requests set confirmed_at = $2, updated_at = now() where id = $1`,
      [request.id, now],
    );
    await client.query("commit");
    return "ok";
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
