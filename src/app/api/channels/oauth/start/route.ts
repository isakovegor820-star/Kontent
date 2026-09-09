// Волна 2 — подключение OAuth-сети (YouTube/Instagram/...). Шаг 1: старт.
// Роут строит URL согласия только для сетей, для которых Композитор уже умеет создать
// полноценный payload публикации. Наличие OAuth-конфига или worker-адаптера само по себе
// сеть не открывает: иначе пользователь подключит канал, но не сможет его выбрать.
//
// Безопасность: генерируем случайный state (CSRF) и PKCE-пару, кладём их в HttpOnly-cookie
// на 10 минут; на колбэке сверяем state и используем verifier. Сессию проверяем и здесь,
// и на колбэке — чужой код к чужому аккаунту не привяжется.

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { getOAuthConfig } from "@/lib/social-providers.mjs";
import { buildAuthUrl, randomState, randomPkce } from "@/lib/oauth.mjs";
import {
  getOAuthProviderCapability,
  hasComposerPayloadSupport,
  isKnownOAuthProvider,
} from "@/lib/oauth-capabilities";
import { OAUTH_STATE_COOKIE, callbackUrlFromReq } from "@/lib/oauth-request";
import { getPool } from "@/lib/db";
import { nativeRequestProjectId } from "@/lib/native-project-request";
import { ProjectAccessError, requireProjectPermission } from "@/lib/project-permissions";
import { OAUTH_STATE_MAX_AGE_S, sealOAuthState } from "@/lib/oauth-state";

export const runtime = "nodejs";

function stateCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: OAUTH_STATE_MAX_AGE_S,
  };
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) {
    return NextResponse.redirect(new URL("/app/settings?oauth=unauthorized", req.url));
  }

  const network = req.nextUrl.searchParams.get("network") || "";
  const cfg = getOAuthConfig(network);
  if (isKnownOAuthProvider(network)) {
    const capability = getOAuthProviderCapability(network, Boolean(cfg));
    if (capability.status === "unsupported") {
      return NextResponse.redirect(
        new URL(`/app/settings?oauth=unsupported&network=${network}`, req.url),
      );
    }
  } else if (cfg && !hasComposerPayloadSupport(network)) {
    // Deny newly configured OAuth adapters by default. A provider must not become
    // connectable merely because credentials were added before Composer support.
    return NextResponse.redirect(
      new URL(`/app/settings?oauth=unsupported&network=${network}`, req.url),
    );
  }
  if (!cfg) {
    // Сеть неизвестна или приложение провайдера ещё не заведено (нет client_id/secret).
    return NextResponse.redirect(new URL(`/app/settings?oauth=not_configured&network=${network}`, req.url));
  }

  let projectId: number;
  try {
    projectId = nativeRequestProjectId(req);
    await requireProjectPermission(getPool(), user.id, projectId, "project.manage");
  } catch (error) {
    if (!(error instanceof ProjectAccessError)) throw error;
    return NextResponse.redirect(new URL(`/app/settings?oauth=forbidden&network=${encodeURIComponent(network)}`, req.url));
  }
  if (!process.env.TOKENS_MASTER_KEY) {
    return NextResponse.redirect(new URL(`/app/settings?oauth=server&network=${encodeURIComponent(network)}`, req.url));
  }

  const state = randomState();
  const pkce = randomPkce();
  const redirectUri = callbackUrlFromReq(req, network);

  const res = NextResponse.redirect(buildAuthUrl(cfg, {
    redirectUri,
    state,
    codeChallenge: pkce.challenge,
  }));

  // Project selection survives native navigation; authenticated state cannot be edited.
  res.cookies.set(
    OAUTH_STATE_COOKIE,
    sealOAuthState({ state, verifier: pkce.verifier, network, userId: user.id, projectId }),
    stateCookieOptions(),
  );
  return res;
}
