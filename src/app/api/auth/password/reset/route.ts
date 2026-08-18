import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { validatePassword } from "@/lib/password";
import { consumePasswordReset, passwordResetRateKey } from "@/lib/password-reset";
import { checkRateLimit, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import { clearSessionCookie } from "@/lib/session";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req, { requireBrowserOrigin: true })) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const limit = await checkRateLimit(
    `password-reset-confirm:ip:${passwordResetRateKey(clientIp(req))}`,
    10,
    900,
  );
  if (!limit.allowed) return rateLimitResponse(limit);

  const body = (await req.json().catch(() => null)) as
    | { token?: unknown; password?: unknown }
    | null;
  const token = String(body?.token ?? "").trim();
  const password = String(body?.password ?? "");
  if (token.length < 20 || token.length > 200) {
    return NextResponse.json({ ok: false, error: "invalid" }, { status: 422 });
  }
  if (validatePassword(password)) {
    return NextResponse.json({ ok: false, error: "bad_password" }, { status: 422 });
  }
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }

  try {
    const result = await consumePasswordReset({ token, password }, getPool());
    if (result !== "ok") {
      return NextResponse.json({ ok: false, error: result }, { status: 422 });
    }
    const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    clearSessionCookie(response);
    return response;
  } catch (error) {
    console.error("[password-reset] confirmation failed", error instanceof Error ? error.name : "error");
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
