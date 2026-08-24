// Д.2 — вход через Telegram Login (тот же наш бот).
// ОБЯЗАТЕЛЬНО проверяем подпись (hash) по токену бота — без неё любой мог бы
// подделать вход. Виджет Telegram работает только на настоящем домене (не localhost),
// поэтому вживую заработает на деплое; логика проверки подписи готова и здесь.

import { JsonBodyReadError, readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { findOrCreateUser } from "@/lib/users";
import { createSession } from "@/lib/session";
import { checkRateLimit, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

const TELEGRAM_AUTH_MAX_AGE_SECONDS = 10 * 60;
const CLOCK_SKEW_SECONDS = 30;
const AUTH_BODY_MAX_BYTES = 16 * 1024;

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req, { requireBrowserOrigin: true })) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const ipLimit = await checkRateLimit(
    `social-login:telegram:ip:${clientIp(req)}`,
    10,
    15 * 60,
    { failureMode: "closed" },
  );
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit);

  const token = process.env.TG_BOT_TOKEN;
  if (!token) {
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }

  let data: Record<string, unknown>;
  try {
    data = (await readJsonBodyValue(req, AUTH_BODY_MAX_BYTES)) as Record<string, unknown>;
  } catch (error) {
    const status = error instanceof JsonBodyReadError ? error.status : 400;
    const code = error instanceof JsonBodyReadError ? error.code : "bad_request";
    return NextResponse.json({ ok: false, error: code }, { status });
  }

  const hash = typeof data.hash === "string" ? data.hash : "";
  if (!/^[a-f0-9]{64}$/iu.test(hash)) {
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
  const computed = createHmac("sha256", secret).update(checkString).digest();
  const suppliedHash = Buffer.from(hash, "hex");

  if (suppliedHash.length !== computed.length || !timingSafeEqual(computed, suppliedHash)) {
    return NextResponse.json({ ok: false, error: "bad_signature" }, { status: 401 });
  }

  // Signed login payloads are bearer assertions. Keep the replay window narrow and
  // reject timestamps suspiciously far in the future as well as stale ones.
  const authDate = Number(data.auth_date);
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const ageSeconds = nowSeconds - authDate;
  if (
    !Number.isSafeInteger(authDate)
    || authDate <= 0
    || ageSeconds > TELEGRAM_AUTH_MAX_AGE_SECONDS
    || ageSeconds < -CLOCK_SKEW_SECONDS
  ) {
    return NextResponse.json({ ok: false, error: "stale" }, { status: 401 });
  }

  const tg_id = Number(data.id);
  if (!Number.isSafeInteger(tg_id) || tg_id <= 0) {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 422 });
  }
  const accountLimit = await checkRateLimit(
    `social-login:telegram:account:${tg_id}`,
    5,
    15 * 60,
    { failureMode: "closed" },
  );
  if (!accountLimit.allowed) return rateLimitResponse(accountLimit);
  const name =
    [data.first_name, data.last_name].filter(Boolean).map(String).join(" ") || null;
  const username = typeof data.username === "string" ? data.username : null;
  const avatar = typeof data.photo_url === "string" ? data.photo_url : null;

  try {
    const { id } = await findOrCreateUser({ tg_id, username, name, avatar });
    const res = NextResponse.json({ ok: true });
    if (!await createSession(res, id, req.headers.get("user-agent"))) {
      return NextResponse.json({ ok: false, error: "session_creation_failed" }, { status: 503 });
    }
    return res;
  } catch (err) {
    console.error("[/api/auth/telegram]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
