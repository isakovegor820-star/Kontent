import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { configuredAppUrl } from "@/lib/password-reset";
import { getPool } from "@/lib/db";
import { emailChangeDeliveryConfigured } from "@/lib/email-change-delivery.mjs";
import {
  createEmailChangeOutboxRequest,
  emailChangeRateKey,
} from "@/lib/email-change";
import { EMAIL } from "@/lib/leads";
import { verifyPassword } from "@/lib/password";
import { profileReauthMethod, validProfileRequestKey } from "@/lib/profile";
import { checkRateLimit, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

const noStore = { "Cache-Control": "no-store" };

function json(requestId: string, body: Record<string, unknown>, status = 200) {
  return NextResponse.json({ ...body, requestId }, { status, headers: noStore });
}

export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(req, { requireBrowserOrigin: true })) {
    return json(requestId, { ok: false, error: "forbidden_origin" }, 403);
  }
  const user = await getSessionUser(req);
  if (!user) return json(requestId, { ok: false, error: "unauthorized" }, 401);

  const byAccount = await checkRateLimit(
    `email-change:account:${user.id}`,
    5,
    3600,
    { failureMode: "closed" },
  );
  if (!byAccount.allowed) return rateLimitResponse(byAccount);
  const byIp = await checkRateLimit(
    `email-change:ip:${emailChangeRateKey(clientIp(req))}`,
    10,
    3600,
    { failureMode: "closed" },
  );
  if (!byIp.allowed) return rateLimitResponse(byIp);

  const body = (await req.json().catch(() => null)) as
    | { email?: unknown; password?: unknown; requestKey?: unknown }
    | null;
  const email = String(body?.email ?? "").trim().toLowerCase();
  const password = String(body?.password ?? "");
  const headerKey = req.headers.get("idempotency-key");
  if (headerKey && body?.requestKey && headerKey !== body.requestKey) {
    return json(requestId, { ok: false, error: "bad_request_key" }, 422);
  }
  const requestKey = headerKey || body?.requestKey;
  if (!validProfileRequestKey(requestKey) || !EMAIL.test(email) || email.length > 320) {
    return json(requestId, { ok: false, error: "bad_request" }, 422);
  }

  try {
    const pool = getPool();
    const account = (
      await pool.query<{
        email: string | null;
        password_hash: string | null;
        tg_id: string | null;
        vk_id: string | null;
        target_taken: boolean;
      }>(
        `select u.email, u.password_hash, u.tg_id, u.vk_id,
                exists(select 1 from users taken where taken.email = $2 and taken.id <> u.id) as target_taken
           from users u where u.id = $1`,
        [user.id, email],
      )
    ).rows[0];
    if (!account) return json(requestId, { ok: false, error: "unauthorized" }, 401);
    if (account.email === email) return json(requestId, { ok: true, status: "unchanged" });

    const reauthMethod = profileReauthMethod(account);
    if (reauthMethod !== "password") {
      return json(requestId, {
        ok: false,
        error: "reauth_required",
        reauthProvider: reauthMethod,
      }, 403);
    }
    if (!password || !(await verifyPassword(password, account.password_hash))) {
      return json(requestId, { ok: false, error: "reauth_failed" }, 403);
    }
    if (account.target_taken) return json(requestId, { ok: false, error: "email_taken" }, 409);

    if (
      !configuredAppUrl()
      || !emailChangeDeliveryConfigured()
      || !String(process.env.TOKENS_MASTER_KEY || "").trim()
    ) {
      return json(requestId, { ok: false, error: "email_delivery_unavailable" }, 503);
    }

    const created = await createEmailChangeOutboxRequest({
      userId: user.id,
      targetEmail: email,
      requestKey,
    }, pool);
    if (created.status === "conflict") {
      return json(requestId, { ok: false, error: "idempotency_conflict" }, 409);
    }
    return json(requestId, {
      ok: true,
      status: "pending_confirmation",
      email: created.targetEmail,
      expiresAt: created.expiresAt.toISOString(),
      replayed: created.status === "replayed",
    }, 202);
  } catch (error) {
    console.error("[/api/settings/profile/email/request]", {
      requestId,
      errorName: error instanceof Error ? error.name : "Error",
      code: typeof (error as { code?: unknown })?.code === "string"
        ? String((error as { code: string }).code).slice(0, 40)
        : "email_change_unavailable",
    });
    return json(requestId, { ok: false, error: "unavailable" }, 503);
  }
}
