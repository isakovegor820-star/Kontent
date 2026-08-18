import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { EMAIL } from "@/lib/leads";
import {
  configuredAppUrl,
  createPasswordResetOutboxRequest,
  passwordResetRateKey,
} from "@/lib/password-reset";
import { checkRateLimit, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

const accepted = () =>
  NextResponse.json(
    {
      ok: true,
      message: "Если аккаунт существует и доставка доступна, инструкция будет отправлена.",
    },
    { status: 202, headers: { "Cache-Control": "no-store" } },
  );

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  const finishAccepted = async () => {
    // Provider work never runs in the request. A common minimum envelope also hides the
    // small DB difference between an existing and an unknown address.
    const remaining = 180 - (Date.now() - startedAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    return accepted();
  };
  if (!hasTrustedMutationOrigin(req, { requireBrowserOrigin: true })) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const ip = clientIp(req);
  const byIp = await checkRateLimit(
    `password-reset:ip:${passwordResetRateKey(ip)}`,
    5,
    3600,
    { failureMode: "closed" },
  );
  if (!byIp.allowed) return rateLimitResponse(byIp);

  const body = (await req.json().catch(() => ({}))) as { email?: unknown };
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!EMAIL.test(email)) return finishAccepted();

  const byAccount = await checkRateLimit(
    `password-reset:acct:${passwordResetRateKey(email)}`,
    3,
    3600,
    { failureMode: "closed" },
  );
  if (!byAccount.allowed) return rateLimitResponse(byAccount);

  const appUrl = configuredAppUrl();
  const deliveryConfigured = Boolean(
    appUrl
      && (process.env.RESEND_API_KEY || process.env.EMAIL_API_KEY)
      && (process.env.PASSWORD_RESET_FROM || process.env.EMAIL_FROM)
      && process.env.TOKENS_MASTER_KEY,
  );
  if (!process.env.DATABASE_URL || !deliveryConfigured) return finishAccepted();

  try {
    await createPasswordResetOutboxRequest({
      email,
      requestIpHash: passwordResetRateKey(ip),
    }, getPool());
  } catch (error) {
    console.error("[password-reset] request failed", error instanceof Error ? error.name : "error");
  }
  return finishAccepted();
}
