// Регистрация по почте и паролю. Человек придумывает свой пароль и сразу входит
// (создаём сессию). Пароль храним только хешем. Заявку того же контакта помечаем registered.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { EMAIL } from "@/lib/leads";
import { findOrCreateUser } from "@/lib/users";
import { createSession } from "@/lib/session";
import { hashPassword, validatePassword } from "@/lib/password";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const b = body as { email?: unknown; password?: unknown; name?: unknown };
  const email = String(b?.email ?? "").trim().toLowerCase();
  const password = String(b?.password ?? "");
  const nameRaw = String(b?.name ?? "").trim();

  if (!EMAIL.test(email)) {
    return NextResponse.json({ ok: false, error: "bad_email" }, { status: 422 });
  }
  const pwProblem = validatePassword(password);
  if (pwProblem) {
    return NextResponse.json({ ok: false, error: "bad_password" }, { status: 422 });
  }

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }

  // Имя необязательно: если не ввели — берём часть почты до «@», чтобы в кабинете было к кому обращаться.
  const name = nameRaw || email.split("@")[0];

  try {
    const pool = getPool();
    const existing = await pool.query<{ id: number; password_hash: string | null }>(
      `select id, password_hash from users where email = $1`,
      [email],
    );

    // Почта уже есть — это вход, а не регистрация. НЕ привязываем пароль к существующему
    // аккаунту без подтверждения владения почтой (иначе захват чужого аккаунта — ревью).
    if (existing.rowCount && existing.rows[0]) {
      return NextResponse.json({ ok: false, error: "email_taken" }, { status: 409 });
    }

    // Новый человек: создаём (с конвертацией заявки) и ставим пароль.
    const hash = await hashPassword(password);
    const { id: userId } = await findOrCreateUser({ email, name });
    await pool.query(`update users set password_hash = $2 where id = $1`, [userId, hash]);

    const res = NextResponse.json({ ok: true });
    await createSession(res, userId, req.headers.get("user-agent"));
    return res;
  } catch (err) {
    console.error("[/api/auth/register]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
