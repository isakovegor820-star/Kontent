// Универсальный движок OAuth 2.0 (authorization code) для подключения зарубежных
// соцсетей — YouTube первым, затем Instagram, X, TikTok, LinkedIn. Волна 2.
//
// Идея та же, что у token-crypto.mjs: ОДИН чистый модуль (только node:crypto + fetch,
// без pg/redis/next), который импортируют И TS-роуты (@/lib/oauth.mjs), И .mjs-воркер
// (./src/lib/oauth.mjs). Никакого дублирования OAuth-логики между роутами и воркером.
//
// Специфику провайдера (endpoints, client_id/secret из env, скоупы, нужен ли PKCE)
// держит реестр social-providers.mjs — сюда передаётся готовый конфиг. Движок провайдеров
// не знает: он умеет строить URL согласия, менять code на токены и обновлять access_token.
//
// Безопасность: state (защита от CSRF на колбэке) и PKCE/S256 (защита от перехвата кода).
// PKCE обязателен для публичных клиентов и включён у всех современных провайдеров;
// для серверного клиента с secret он остаётся дополнительной защитой, а не обузой.

import { createHash, randomBytes } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * @typedef {Object} OAuthProviderConfig
 * @property {string}  id            — 'youtube' | 'instagram' | ... (он же provider в oauth_tokens)
 * @property {string}  authEndpoint  — URL экрана согласия (authorize)
 * @property {string}  tokenEndpoint — URL обмена кода/обновления токена
 * @property {string}  clientId
 * @property {string}  clientSecret
 * @property {string[]} scopes       — запрашиваемые права
 * @property {boolean} [usePkce]     — слать code_challenge/code_verifier (default true)
 * @property {Record<string,string>} [authParams] — доп. параметры authorize (например, access_type=offline)
 */

/* ------------------------------------------------------------------ генерация */

/** Случайный state для защиты от CSRF: кладём в cookie на старте, сверяем на колбэке. */
export function randomState() {
  return randomBytes(24).toString("base64url");
}

/**
 * PKCE-пара (RFC 7636). code_verifier — случайная строка, code_challenge — её SHA-256
 * в base64url. На старте шлём challenge, на колбэке — verifier; сервер сверяет хэш.
 */
export function randomPkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, method: "S256" };
}

/* --------------------------------------------------------------------- URL */

/**
 * Строит URL экрана согласия провайдера. redirectUri — наш колбэк
 * (https://<домен>/api/channels/oauth/callback?network=<id>).
 */
export function buildAuthUrl(cfg, { redirectUri, state, codeChallenge }) {
  const url = new URL(cfg.authEndpoint);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", cfg.scopes.join(" "));
  url.searchParams.set("state", state);
  if (cfg.usePkce !== false && codeChallenge) {
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  // Доп. параметры провайдера (например, access_type=offline у Google — даёт refresh_token).
  for (const [k, v] of Object.entries(cfg.authParams ?? {})) url.searchParams.set(k, v);
  return url.toString();
}

/* ------------------------------------------------------------------- обмен */

async function tokenRequest(cfg, params) {
  const body = new URLSearchParams(params);
  const res = await fetch(cfg.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body,
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || typeof data !== "object" || data.error) {
    const desc = data?.error_description || data?.error || `HTTP ${res.status}`;
    const err = new Error(`oauth token error: ${desc}`);
    err.code = data?.error || "token_error";
    throw err;
  }
  return data;
}

/**
 * Меняет authorization code на токены.
 * Возвращает { accessToken, refreshToken, expiresIn, scope, raw }.
 * refreshToken может быть null (провайдер не выдал — например, без access_type=offline).
 */
export async function exchangeCode(cfg, { code, redirectUri, codeVerifier }) {
  const params = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  };
  if (cfg.usePkce !== false && codeVerifier) params.code_verifier = codeVerifier;
  const data = await tokenRequest(cfg, params);
  return normalizeTokens(data);
}

/**
 * Обновляет access_token по refresh_token (grant_type=refresh_token).
 * Некоторые провайдеры (Google) могут вернуть и новый refresh_token — учитываем.
 */
export async function refreshAccessToken(cfg, refreshToken) {
  const data = await tokenRequest(cfg, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
  const norm = normalizeTokens(data);
  // refresh_token может отсутствовать в ответе — тогда живёт прежний.
  return { ...norm, refreshToken: norm.refreshToken ?? refreshToken };
}

/** Приводим ответ провайдера к единой форме. expires_in (сек) → expiresIn. */
function normalizeTokens(data) {
  return {
    accessToken: typeof data.access_token === "string" ? data.access_token : "",
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : null,
    expiresIn: typeof data.expires_in === "number" ? data.expires_in : null,
    scope: typeof data.scope === "string" ? data.scope : null,
    raw: data,
  };
}
