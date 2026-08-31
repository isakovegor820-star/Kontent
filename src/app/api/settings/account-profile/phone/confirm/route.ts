import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { getPool } from "@/lib/db";
import { PHONE_CODE_MAX_ATTEMPTS, verifyPhoneCode } from "@/lib/phone-verification";
import { phoneVerificationMode } from "@/lib/phone-verification-mode.mjs";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin", requestId }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized", requestId }, { status: 401 });
  if (phoneVerificationMode() !== "temporary") {
    return NextResponse.json(
      { ok: false, error: "phone_delivery_unavailable", requestId },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  const body = await readJsonBodyValue(req).catch(() => null) as { code?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!/^[0-9]{6}$/u.test(code)) {
    return NextResponse.json({ ok: false, error: "bad_code", requestId }, { status: 422 });
  }
  const client = await getPool().connect().catch(() => null);
  if (!client) return NextResponse.json({ ok: false, error: "unavailable", requestId }, { status: 503 });
  try {
    await client.query("begin");
    const challenge = (
      await client.query<{
        pending_phone: string | null;
        phone_verification_hash: string | null;
        phone_verification_expires_at: Date | string | null;
        phone_verification_attempts: number;
      }>(
        `select pending_phone, phone_verification_hash, phone_verification_expires_at,
                phone_verification_attempts
           from user_account_settings where user_id = $1 for update`,
        [user.id],
      )
    ).rows[0];
    if (!challenge?.pending_phone || !challenge.phone_verification_hash || !challenge.phone_verification_expires_at) {
      await client.query("rollback");
      return NextResponse.json({ ok: false, error: "challenge_missing", requestId }, { status: 409 });
    }
    if (new Date(challenge.phone_verification_expires_at).getTime() <= Date.now()) {
      await client.query(
        `update user_account_settings
            set pending_phone = null, phone_verification_hash = null,
                phone_verification_expires_at = null, phone_verification_attempts = 0
          where user_id = $1`,
        [user.id],
      );
      await client.query("commit");
      return NextResponse.json({ ok: false, error: "code_expired", requestId }, { status: 410 });
    }
    if (challenge.phone_verification_attempts >= PHONE_CODE_MAX_ATTEMPTS) {
      await client.query("rollback");
      return NextResponse.json({ ok: false, error: "attempts_exceeded", requestId }, { status: 429 });
    }
    if (!verifyPhoneCode(code, challenge.phone_verification_hash)) {
      await client.query(
        `update user_account_settings
            set phone_verification_attempts = least(5, phone_verification_attempts + 1),
                updated_at = now()
          where user_id = $1`,
        [user.id],
      );
      await client.query("commit");
      return NextResponse.json({ ok: false, error: "bad_code", requestId }, { status: 422 });
    }
    await client.query(
      `update user_account_settings
          set phone = pending_phone, phone_verified_at = now(), pending_phone = null,
              phone_verification_hash = null, phone_verification_expires_at = null,
              phone_verification_attempts = 0, updated_at = now()
        where user_id = $1`,
      [user.id],
    );
    await client.query("commit");
    return NextResponse.json({ ok: true, phone: challenge.pending_phone, requestId });
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    console.error("[/api/settings/account-profile/phone/confirm]", {
      requestId,
      errorName: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json({ ok: false, error: "unavailable", requestId }, { status: 503 });
  } finally {
    client.release();
  }
}
