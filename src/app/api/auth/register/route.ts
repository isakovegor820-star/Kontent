// Регистрация по почте и паролю. Человек придумывает свой пароль и сразу входит
// (создаём сессию). Пароль храним только хешем. Заявку того же контакта помечаем registered.

import { JsonBodyReadError, readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { EMAIL } from "@/lib/leads";
import { convertMatchingLeadAfterRegistration } from "@/lib/users";
import { registerPasswordUser } from "@/lib/password-registration";
import { createSession } from "@/lib/session";
import { hashPassword, validatePassword } from "@/lib/password";
import { checkRateLimit, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";
const AUTH_BODY_MAX_BYTES = 16 * 1024;

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req, { requireBrowserOrigin: true })) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await readJsonBodyValue(req, AUTH_BODY_MAX_BYTES);
  } catch (error) {
    const status = error instanceof JsonBodyReadError ? error.status : 400;
    const code = error instanceof JsonBodyReadError ? error.code : "bad_request";
    return NextResponse.json({ ok: false, error: code }, { status });
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

  // Режем массовое создание аккаунтов: не больше 5 регистраций с одного IP в час.
  const byIp = await checkRateLimit(
    `register:ip:${clientIp(req)}`,
    5,
    3600,
    { failureMode: "closed" },
  );
  if (!byIp.allowed) return rateLimitResponse(byIp);

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }

  // Имя необязательно: если не ввели — берём часть почты до «@», чтобы в кабинете было к кому обращаться.
  const name = nameRaw || email.split("@")[0];

  try {
    const pool = getPool();
    const hash = await hashPassword(password);
    const registration = await registerPasswordUser({ pool, email, name, passwordHash: hash });
    if (!registration.ok) {
      return NextResponse.json({ ok: false, error: registration.error }, { status: 409 });
    }

    // Только после commit: сбой CRM/Telegram не откатывает и не маскирует созданный аккаунт.
    await convertMatchingLeadAfterRegistration([email], name);

    const res = NextResponse.json({ ok: true });
    try {
      const created = await createSession(res, registration.userId, req.headers.get("user-agent"));
      if (!created) {
        return NextResponse.json({
          ok: false,
          error: "session_creation_failed",
          accountCreated: true,
        }, { status: 503 });
      }
    } catch (error) {
      console.warn("[registration_event]", {
        event: "session_creation_failed",
        userId: registration.userId,
        code: error && typeof error === "object" && "code" in error ? String(error.code) : "unknown",
      });
      return NextResponse.json({
        ok: false,
        error: "session_creation_failed",
        accountCreated: true,
      }, { status: 503 });
    }
    return res;
  } catch (err) {
    console.error("[/api/auth/register]", {
      code: err && typeof err === "object" && "code" in err ? String(err.code) : "unknown",
    });
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
