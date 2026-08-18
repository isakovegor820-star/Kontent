// Д.2 — вход через VK ID (то же приложение VK, что будет постить в Д.4).
// Принимаем code от VK ID → меняем на токен → получаем vk_id → вход.
//
// ВНИМАНИЕ: VK ID работает только с зарегистрированным приложением на dev.vk.com
// и на настоящем домене. Приложение решено заводить на деплое (владелец),
// поэтому этот обмен финализируется тогда же — точные параметры VK ID SDK
// (device_id/code_verifier/PKCE) зависят от версии и проверяются на реальном
// приложении. Структура — по ТЗ (раздел 13.4 / Д.2).

import { NextRequest, NextResponse } from "next/server";
import { findOrCreateUser } from "@/lib/users";
import { createSession } from "@/lib/session";
import { checkRateLimit, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const ipLimit = await checkRateLimit(
    `social-login:vk:ip:${clientIp(req)}`,
    10,
    15 * 60,
    { failureMode: "closed" },
  );
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit);

  const appId = process.env.VK_APP_ID;
  const secret = process.env.VK_APP_SECRET;
  if (!appId || !secret) {
    // Приложение VK ещё не заведено — вход через VK пока недоступен.
    return NextResponse.json({ ok: false, error: "vk_not_configured" }, { status: 503 });
  }

  let data: { code?: unknown; device_id?: unknown; code_verifier?: unknown };
  try {
    data = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  const code = typeof data.code === "string" ? data.code : "";
  const deviceId = typeof data.device_id === "string" ? data.device_id.trim() : "";
  const codeVerifier = typeof data.code_verifier === "string" ? data.code_verifier.trim() : "";
  if (!code || code.length > 2_048 || !deviceId || deviceId.length > 512
    || codeVerifier.length < 43 || codeVerifier.length > 128) {
    return NextResponse.json({ ok: false, error: "no_code" }, { status: 422 });
  }

  try {
    // Обмен кода на токен через VK ID.
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: appId,
      client_secret: secret,
      device_id: deviceId,
      code_verifier: codeVerifier,
    });
    const tokenRes = await fetch("https://id.vk.com/oauth2/auth", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params,
    });
    const tokenData = (await tokenRes.json().catch(() => null)) as {
      access_token?: string;
      user_id?: number;
    } | null;

    if (!tokenRes.ok || !tokenData?.user_id) {
      console.error("[/api/auth/vk] token exchange failed", {
        status: tokenRes.status,
        code: "vk_exchange_failed",
      });
      return NextResponse.json({ ok: false, error: "vk_exchange_failed" }, { status: 401 });
    }

    const vk_id = Number(tokenData.user_id);
    if (!Number.isSafeInteger(vk_id) || vk_id <= 0) {
      return NextResponse.json({ ok: false, error: "vk_exchange_failed" }, { status: 401 });
    }
    const accountLimit = await checkRateLimit(
      `social-login:vk:account:${vk_id}`,
      5,
      15 * 60,
      { failureMode: "closed" },
    );
    if (!accountLimit.allowed) return rateLimitResponse(accountLimit);
    const { id } = await findOrCreateUser({ vk_id, name: `VK ${vk_id}` });

    const res = NextResponse.json({ ok: true });
    if (!await createSession(res, id, req.headers.get("user-agent"))) {
      return NextResponse.json({ ok: false, error: "session_creation_failed" }, { status: 503 });
    }
    return res;
  } catch (err) {
    console.error("[/api/auth/vk] request failed", {
      name: err instanceof Error ? err.name : "error",
    });
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
