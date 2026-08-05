// Вход по почте и паролю. Проверяем пароль по хешу, при успехе — сессия на 30 дней.
// На неверную почту и неверный пароль отвечаем одинаково — не подсказываем, что именно не так.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { createSession } from "@/lib/session";
import { verifyPassword } from "@/lib/password";
import { checkRateLimit, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const b = body as { email?: unknown; password?: unknown };
  const email = String(b?.email ?? "").trim().toLowerCase();
  const password = String(b?.password ?? "");

  if (!email || !password) {
    return NextResponse.json({ ok: false, error: "invalid" }, { status: 401 });
  }

  // Два потолка сразу: по IP (режем брутфорс с одного источника) и по аккаунту
  // (режем распределённую атаку на одну почту с разных IP). Окно 15 минут.
  const ip = clientIp(req);
  const byIp = await checkRateLimit(`login:ip:${ip}`, 10, 900);
  if (!byIp.allowed) return rateLimitResponse(byIp);
  const byAccount = await checkRateLimit(`login:acct:${email}`, 5, 900);
  if (!byAccount.allowed) return rateLimitResponse(byAccount);

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }

  try {
    const pool = getPool();
    const row = (
      await pool.query<{ id: number; password_hash: string | null; credential_epoch: number | string }>(
        `select id, password_hash, credential_epoch from users where email = $1`,
        [email],
      )
    ).rows[0];

    const ok = row ? await verifyPassword(password, row.password_hash) : false;
    if (!ok || !row) {
      return NextResponse.json({ ok: false, error: "invalid" }, { status: 401 });
    }

    const res = NextResponse.json({ ok: true });
    const created = await createSession(
      res,
      row.id,
      req.headers.get("user-agent"),
      Number(row.credential_epoch),
    );
    if (!created) {
      // Password changed after verification. Do not mint a session for the stale hash.
      return NextResponse.json({ ok: false, error: "invalid" }, { status: 401 });
    }
    return res;
  } catch (err) {
    console.error("[/api/auth/login]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
