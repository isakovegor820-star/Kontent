// Вход по почте и паролю. Проверяем пароль по хешу, при успехе — сессия на 30 дней.
// На неверную почту и неверный пароль отвечаем одинаково — не подсказываем, что именно не так.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { createSession } from "@/lib/session";
import { verifyPassword } from "@/lib/password";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
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

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }

  try {
    const pool = getPool();
    const row = (
      await pool.query<{ id: number; password_hash: string | null }>(
        `select id, password_hash from users where email = $1`,
        [email],
      )
    ).rows[0];

    const ok = row ? await verifyPassword(password, row.password_hash) : false;
    if (!ok || !row) {
      return NextResponse.json({ ok: false, error: "invalid" }, { status: 401 });
    }

    const res = NextResponse.json({ ok: true });
    await createSession(res, row.id, req.headers.get("user-agent"));
    return res;
  } catch (err) {
    console.error("[/api/auth/login]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
