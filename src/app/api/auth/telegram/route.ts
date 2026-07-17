// Д.2 — вход через Telegram Login (тот же наш бот).
// ОБЯЗАТЕЛЬНО проверяем подпись (hash) по токену бота — без неё любой мог бы
// подделать вход. Виджет Telegram работает только на настоящем домене (не localhost),
// поэтому вживую заработает на деплое; логика проверки подписи готова и здесь.

import { NextRequest, NextResponse } from "next/server";
import { createHash, createHmac } from "node:crypto";
import { findOrCreateUser } from "@/lib/users";
import { createSession } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const token = process.env.TG_BOT_TOKEN;
  if (!token) {
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }

  let data: Record<string, unknown>;
  try {
    data = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const hash = typeof data.hash === "string" ? data.hash : "";
  if (!hash) {
    return NextResponse.json({ ok: false, error: "no_hash" }, { status: 401 });
  }

  // Строка проверки: все поля КРОМЕ hash, отсортированы по ключу, склеены «key=value\n».
  const checkString = Object.keys(data)
    .filter((k) => k !== "hash")
    .sort()
    .map((k) => `${k}=${String(data[k])}`)
    .join("\n");

  // Ключ = SHA256(токен бота); подпись = HMAC-SHA256(строка, ключ).
  const secret = createHash("sha256").update(token).digest();
  const computed = createHmac("sha256", secret).update(checkString).digest("hex");

  if (computed !== hash) {
    return NextResponse.json({ ok: false, error: "bad_signature" }, { status: 401 });
  }

  // Подпись верна — проверим свежесть: auth_date не старше суток.
  const authDate = Number(data.auth_date);
  if (!authDate || Date.now() / 1000 - authDate > 86400) {
    return NextResponse.json({ ok: false, error: "stale" }, { status: 401 });
  }

  const tg_id = Number(data.id);
  if (!tg_id) {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 422 });
  }
  const name =
    [data.first_name, data.last_name].filter(Boolean).map(String).join(" ") || null;
  const username = typeof data.username === "string" ? data.username : null;
  const avatar = typeof data.photo_url === "string" ? data.photo_url : null;

  try {
    const { id } = await findOrCreateUser({ tg_id, username, name, avatar });
    const res = NextResponse.json({ ok: true });
    await createSession(res, id, req.headers.get("user-agent"));
    return res;
  } catch (err) {
    console.error("[/api/auth/telegram]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
