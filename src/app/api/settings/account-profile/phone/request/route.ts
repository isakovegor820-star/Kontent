import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { normalizePhone } from "@/lib/account-settings";
import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { getPool } from "@/lib/db";
import { createPhoneVerificationCode, PHONE_CODE_TTL_MS } from "@/lib/phone-verification";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
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
  const rate = await checkRateLimit(`profile:phone:user:${user.id}`, 5, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);
  const body = await readJsonBodyValue(req).catch(() => null) as { phone?: unknown } | null;
  const phone = normalizePhone(body?.phone);
  if (!phone) return NextResponse.json({ ok: false, error: "bad_phone", requestId }, { status: 422 });
  const temporaryMode = process.env.NODE_ENV !== "production"
    || process.env.AURORA_TEMPORARY_PHONE_VERIFICATION === "true";
  if (!temporaryMode) {
    return NextResponse.json(
      { ok: false, error: "phone_delivery_unavailable", requestId },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  const challenge = createPhoneVerificationCode();
  const expiresAt = new Date(Date.now() + PHONE_CODE_TTL_MS);
  try {
    await getPool().query(
      `insert into user_account_settings (
         user_id, display_name, pending_phone, phone_verification_hash,
         phone_verification_expires_at, phone_verification_attempts, updated_at
       ) values ($1,$2,$3,$4,$5,0,now())
       on conflict (user_id) do update
         set pending_phone = excluded.pending_phone,
             phone_verification_hash = excluded.phone_verification_hash,
             phone_verification_expires_at = excluded.phone_verification_expires_at,
             phone_verification_attempts = 0,
             updated_at = now()`,
      [user.id, user.name ?? "Пользователь", phone, challenge.encodedHash, expiresAt],
    );
    return NextResponse.json({
      ok: true,
      phone,
      expiresAt: expiresAt.toISOString(),
      temporaryCode: challenge.code,
      temporary: true,
      requestId,
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("[/api/settings/account-profile/phone/request]", {
      requestId,
      errorName: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json({ ok: false, error: "unavailable", requestId }, { status: 503 });
  }
}
