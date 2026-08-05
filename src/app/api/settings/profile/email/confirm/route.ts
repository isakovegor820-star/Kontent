import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { consumeEmailChange, emailChangeRateKey } from "@/lib/email-change";
import { getPool } from "@/lib/db";
import { checkRateLimit, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin", requestId }, { status: 403 });
  }
  const limit = await checkRateLimit(
    `email-change-confirm:ip:${emailChangeRateKey(clientIp(req))}`,
    10,
    900,
    { failureMode: "closed" },
  );
  if (!limit.allowed) return rateLimitResponse(limit);

  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  const token = String(body?.token ?? "").trim();
  if (token.length < 20 || token.length > 200) {
    return NextResponse.json({ ok: false, error: "invalid", requestId }, { status: 422 });
  }
  try {
    const result = await consumeEmailChange({ token }, getPool());
    if (result === "ok" || result === "already_confirmed") {
      return NextResponse.json({
        ok: true,
        status: result === "ok" ? "confirmed" : "already_confirmed",
        requestId,
      }, { headers: { "Cache-Control": "no-store" } });
    }
    const status = result === "email_taken" ? 409 : 422;
    return NextResponse.json({ ok: false, error: result, requestId }, { status });
  } catch (error) {
    console.error("[/api/settings/profile/email/confirm]", {
      requestId,
      errorName: error instanceof Error ? error.name : "Error",
      code: typeof (error as { code?: unknown })?.code === "string"
        ? String((error as { code: string }).code).slice(0, 40)
        : "email_change_unavailable",
    });
    return NextResponse.json({ ok: false, error: "unavailable", requestId }, { status: 503 });
  }
}
