// Волна 2 — подключение OAuth-сети. Шаг 2: колбэк от провайдера.
// Провайдер редиректит сюда с code и state. Сверяем state (CSRF), меняем code на токены
// (с PKCE-verifier из cookie), пост-обрабатываем (резолв канала/аккаунта), ШИФРУЕМ токены
// (AES-GCM, привязка к user_id:provider) и сохраняем oauth_tokens + channels. В конце —
// редирект в настройки с флагом, чтобы интерфейс показал «подключено».
//
// Владение каналом: один аккаунт платформы = один активный канал (partial unique в схеме);
// гонку между select и insert ловим кодом 23505, как у TG/VK.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { checkRateLimit, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import { getOAuthConfig, getAdapter } from "@/lib/social-providers.mjs";
import { exchangeCode } from "@/lib/oauth.mjs";
import { encryptToken } from "@/lib/token-crypto.mjs";
import { OAUTH_STATE_COOKIE, callbackUrlFromReq } from "@/lib/oauth-request";

export const runtime = "nodejs";

// Колонка внешнего id в channels для каждой сети (правило владения + витрина).
const EXTERNAL_ID_COLUMN: Record<string, string> = {
  youtube: "youtube_channel_id",
  instagram: "instagram_account_id",
  x: "x_account_id",
  tiktok: "tiktok_account_id",
  linkedin: "linkedin_account_id",
};

const CLEAR_OAUTH_COOKIE = { httpOnly: true, path: "/", maxAge: 0 } as const;

function settingsRedirect(req: NextRequest, params: string): NextResponse {
  const response = NextResponse.redirect(new URL(`/app/settings?${params}`, req.url));
  response.cookies.set(OAUTH_STATE_COOKIE, "", CLEAR_OAUTH_COOKIE);
  return response;
}

function safeOAuthError(error: unknown): { name: string; code?: string } {
  const value = error && typeof error === "object" ? error as { name?: unknown; code?: unknown } : null;
  return {
    name: typeof value?.name === "string" ? value.name.slice(0, 80) : "oauth_error",
    code: typeof value?.code === "string" ? value.code.slice(0, 80) : undefined,
  };
}

export async function GET(req: NextRequest) {
  const network = req.nextUrl.searchParams.get("network") || "";
  const label = network || "сеть";

  // Провайдер мог вернуть ошибку (пользователь отказался на экране согласия).
  const providerError = req.nextUrl.searchParams.get("error");
  if (providerError) {
    return settingsRedirect(req, `oauth=denied&network=${network}`);
  }

  const user = await getSessionUser(req);
  if (!user) return settingsRedirect(req, `oauth=unauthorized&network=${network}`);

  // Чувствительный роут (обмен чужих кодов): режем частые переборы по IP.
  const ip = clientIp(req);
  const byIp = await checkRateLimit(`oauth-callback:ip:${ip}`, 20, 900);
  if (!byIp.allowed) {
    const response = rateLimitResponse(byIp);
    response.cookies.set(OAUTH_STATE_COOKIE, "", CLEAR_OAUTH_COOKIE);
    return response;
  }

  const code = req.nextUrl.searchParams.get("code") || "";
  const state = req.nextUrl.searchParams.get("state") || "";

  // Достаём и сразу жгём cookie состояния (одноразовое использование).
  const raw = req.cookies.get(OAUTH_STATE_COOKIE)?.value;
  if (!raw) return settingsRedirect(req, `oauth=expired&network=${network}`);

  let saved: { state?: string; verifier?: string; network?: string; userId?: number };
  try {
    saved = JSON.parse(raw);
  } catch {
    return settingsRedirect(req, `oauth=expired&network=${network}`);
  }

  // Сверяем state, сеть и владельца. Несовпадение = чужой/подменённый код.
  if (!state || saved.state !== state || saved.network !== network || saved.userId !== user.id) {
    return settingsRedirect(req, `oauth=state_mismatch&network=${network}`);
  }

  const cfg = getOAuthConfig(network);
  const adapter = getAdapter(network);
  const idCol = EXTERNAL_ID_COLUMN[network];
  if (!cfg || !adapter || !idCol) {
    return settingsRedirect(req, `oauth=not_configured&network=${network}`);
  }

  if (!process.env.TOKENS_MASTER_KEY) {
    console.error("[/api/channels/oauth/callback] TOKENS_MASTER_KEY не задан — шифровать токен нечем");
    return settingsRedirect(req, `oauth=server&network=${network}`);
  }

  try {
    // 1) code → токены (с PKCE-verifier).
    const redirectUri = callbackUrlFromReq(req, network);
    const tokens = await exchangeCode(cfg, { code, redirectUri, codeVerifier: saved.verifier });
    if (!tokens.accessToken) {
      return settingsRedirect(req, `oauth=exchange_failed&network=${network}`);
    }

    // 2) Пост-обработка: резолв канала/аккаунта, иногда замена токена (IG long-lived).
    const fin = await adapter.finalizeTokens(tokens);
    if (!fin.ok) {
      console.warn("oauth_callback_finalize_failed", { provider: network, code: "account_resolution_failed" });
      return settingsRedirect(req, `oauth=no_account&network=${network}`);
    }

    const storeAccess = fin.tokens?.accessToken ?? tokens.accessToken;
    const storeRefresh = fin.tokens ? fin.tokens.refreshToken : tokens.refreshToken;
    const expiresIn = fin.tokens?.expiresIn ?? tokens.expiresIn;
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;

    // 3) Шифруем (AAD = user_id:provider) и сохраняем/обновляем токен.
    const accessEnc = encryptToken(storeAccess, { userId: user.id, provider: network });
    const refreshEnc = storeRefresh
      ? encryptToken(storeRefresh, { userId: user.id, provider: network })
      : null;

    const pool = getPool();
    const meta = JSON.stringify(fin.meta ?? {});
    const client = await pool.connect();
    try {
      await client.query("begin");
      const tok = await client.query<{ id: number }>(
        `insert into oauth_tokens
         (user_id, provider, external_id, access_token, refresh_token, scopes, expires_at, meta)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       on conflict (user_id, provider, external_id) where is_active and external_id is not null
       do update set access_token = excluded.access_token,
                     refresh_token = excluded.refresh_token,
                     scopes = excluded.scopes,
                     expires_at = excluded.expires_at,
                     meta = excluded.meta,
                     is_active = true,
                     updated_at = now()
       returning id`,
        [user.id, network, fin.externalId, accessEnc, refreshEnc, tokens.scope, expiresAt, meta],
      );
      const tokenId = tok.rows[0].id;

      // 4) Канал и token живут в одной транзакции: конфликт владения не оставляет orphan token.
      const existing = await client.query<{ id: number }>(
        `select id from channels where user_id = $1 and ${idCol} = $2 for update`,
        [user.id, fin.externalId],
      );
      if (existing.rowCount) {
        await client.query(
          `update channels set title = $2, handle = $3, oauth_token_id = $4,
              is_active = true, status = 'active', last_auth_error_code = null,
              last_auth_error_at = null, disconnected_at = null, updated_at = now()
            where id = $1`,
          [existing.rows[0].id, fin.meta?.title ?? null, fin.meta?.handle ?? null, tokenId],
        );
      } else {
        await client.query(
          `insert into channels (user_id, network, ${idCol}, oauth_token_id, title, handle)
           values ($1, $2, $3, $4, $5, $6)`,
          [user.id, network, fin.externalId, tokenId, fin.meta?.title ?? null, fin.meta?.handle ?? null],
        );
      }
      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => {});
      if ((err as { code?: string }).code === "23505") {
        return settingsRedirect(req, `oauth=taken&network=${network}`);
      }
      throw err;
    } finally {
      client.release();
    }

    return settingsRedirect(req, `connected=${network}`);
  } catch (err) {
    console.error("oauth_callback_failed", { provider: label, ...safeOAuthError(err) });
    return settingsRedirect(req, `oauth=server&network=${network}`);
  }
}
