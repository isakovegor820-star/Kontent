// Волна 2 — подключение OAuth-сети (YouTube/Instagram/...). Шаг 1: старт.
// Пользователь жмёт «Подключить YouTube» в настройках → этот роут строит URL экрана
// согласия провайдера и редиректит туда. «Перешёл по ссылке и всё работает»: никаких
// ручных токенов, в отличие от VK-модели волны 1.
//
// Безопасность: генерируем случайный state (CSRF) и PKCE-пару, кладём их в HttpOnly-cookie
// на 10 минут; на колбэке сверяем state и используем verifier. Сессию проверяем и здесь,
// и на колбэке — чужой код к чужому аккаунту не привяжется.

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { getOAuthConfig } from "@/lib/social-providers.mjs";
import { buildAuthUrl, randomState, randomPkce } from "@/lib/oauth.mjs";

export const runtime = "nodejs";

export const OAUTH_STATE_COOKIE = "oauth_state";
const STATE_MAX_AGE_S = 600; // 10 минут на прохождение экрана согласия

function stateCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: STATE_MAX_AGE_S,
  };
}

/** Абсолютный URL колбэка из заголовков запроса (Vercel шлёт x-forwarded-*). */
export function callbackUrlFromReq(req: NextRequest, network: string): string {
  const proto = req.headers.get("x-forwarded-proto") || "http";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "localhost:3000";
  return `${proto}://${host}/api/channels/oauth/callback?network=${network}`;
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) {
    return NextResponse.redirect(new URL("/app/settings?oauth=unauthorized", req.url));
  }

  const network = req.nextUrl.searchParams.get("network") || "";
  const cfg = getOAuthConfig(network);
  if (!cfg) {
    // Сеть неизвестна или приложение провайдера ещё не заведено (нет client_id/secret).
    return NextResponse.redirect(new URL(`/app/settings?oauth=not_configured&network=${network}`, req.url));
  }

  const state = randomState();
  const pkce = randomPkce();
  const redirectUri = callbackUrlFromReq(req, network);

  const res = NextResponse.redirect(buildAuthUrl(cfg, {
    redirectUri,
    state,
    codeChallenge: pkce.challenge,
  }));

  // state + verifier + сеть + пользователь — в HttpOnly-cookie до колбэка.
  res.cookies.set(
    OAUTH_STATE_COOKIE,
    JSON.stringify({ state, verifier: pkce.verifier, network, userId: user.id }),
    stateCookieOptions(),
  );
  return res;
}
