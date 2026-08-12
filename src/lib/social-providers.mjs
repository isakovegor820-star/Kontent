// Реестр провайдеров соцсетей (Волна 2). Единая точка правды о каждой сети:
//   - OAuth-конфиг (endpoints, client_id/secret из env, скоупы) — для роутов подключения;
//   - адаптер (finalizeTokens/publish/refresh) — для роутов И воркера;
//   - витринные метаданные (label, статус) — для пикера сетей в настройках.
//
// .mjs намеренно: модуль импортирует и TS-роут, и .mjs-воркер. Добавление новой сети =
// новый объект здесь; диспетчер воркера и роуты не меняются.
//
// Безопасность: client_secret читаем только из env, никогда не логируем. Токены в БД
// кладутся ТОЛЬКО в AES-GCM конвертах (token-crypto.mjs) — этим занимается колбэк-роут.

import { reconcileUploadSession, resolveChannel, uploadVideo } from "./youtube.mjs";
import { exchangeLongLivedToken, reconcileMediaCreation, resolveIgUser, publishMedia } from "./instagram.mjs";
import { assertFutureProviderAdapter } from "./social-provider-contract.mjs";
import { providerSupportsOperation } from "./provider-capabilities.mjs";
import { TENCHAT_ADAPTER } from "./tenchat-adapter.mjs";

const GRAPH_BASE = "https://graph.facebook.com/v19.0";

/* ------------------------------------------------------------ OAuth-конфиги */

/**
 * OAuth-конфиг сети (читает env на вызов, чтобы смена ключей подхватывалась без рестарта).
 * null — сеть ещё не настроена (нет client_id/secret) → роут ответит «not_configured».
 */
export function getOAuthConfig(network) {
  switch (network) {
    case "youtube": {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      if (!clientId || !clientSecret) return null;
      return {
        id: "youtube",
        authEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        clientId,
        clientSecret,
        scopes: [
          "https://www.googleapis.com/auth/youtube.upload",
          "https://www.googleapis.com/auth/youtube.readonly",
        ],
        usePkce: true,
        // offline → Google выдаст refresh_token (бессрочный); prompt=consent — надёжнее.
        authParams: { access_type: "offline", prompt: "consent" },
      };
    }
    case "instagram": {
      const clientId = process.env.META_APP_ID;
      const clientSecret = process.env.META_APP_SECRET;
      if (!clientId || !clientSecret) return null;
      return {
        id: "instagram",
        authEndpoint: "https://www.facebook.com/v19.0/dialog/oauth",
        tokenEndpoint: `${GRAPH_BASE}/oauth/access_token`,
        clientId,
        clientSecret,
        scopes: [
          "instagram_content_publish",
          "pages_manage_posts",
          "pages_read_engagement",
          "pages_show_list",
        ],
        usePkce: true,
        authParams: {},
      };
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ адаптеры */

/**
 * YouTube: после обмена кода резолвим канал (mine=true) → externalId + витрина.
 * Токены сохраняем как есть (access ~1 ч, refresh бессрочный).
 */
async function youtubeFinalize(tokens) {
  const channel = await resolveChannel(tokens.accessToken);
  if (!channel) {
    return { ok: false, reason: "не удалось определить YouTube-канал (токен отозван или нет канала)" };
  }
  return {
    ok: true,
    externalId: channel.id,
    meta: { title: channel.title, handle: channel.handle, avatar: channel.avatar },
  };
}

/** Публикация видео на YouTube. media — из posts.media (url/buffer/data:URL). */
async function youtubePublish(accessToken, payload) {
  const res = await uploadVideo(accessToken, {
    title: payload.title || "Видео из Авроры",
    description: payload.text || "",
    privacyStatus: payload.privacyStatus || "private",
    media: payload.media,
  });
  if (!res.ok) return res;
  return {
    ...res,
    externalId: res.videoId,
    postUrl: res.url,
  };
}

/**
 * Instagram: короткоживущий токен FB Login → long-lived (60 дней) → ищем IG business
 * аккаунт, привязанный к странице FB. externalId = IG user id (нужен для публикации).
 */
async function instagramFinalize(tokens) {
  const cfg = getOAuthConfig("instagram");
  if (!cfg) return { ok: false, reason: "instagram не настроен" };

  const long = await exchangeLongLivedToken({
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    shortToken: tokens.accessToken,
  });
  if (!long) return { ok: false, reason: "не удалось обменять токен на долгосрочный" };

  const ig = await findIgBusinessAccount(long.accessToken);
  if (!ig) {
    return {
      ok: false,
      reason: "не нашли Instagram Business-аккаунт, привязанный к странице Facebook. " +
        "Переведи профиль в Business/Creator и привяжи его к странице FB.",
    };
  }

  const profile = await resolveIgUser(long.accessToken, ig.id);
  return {
    ok: true,
    externalId: ig.id,
    // Сохраняем long-lived токен (60 дней) вместо короткого.
    tokens: { accessToken: long.accessToken, refreshToken: null, expiresIn: long.expiresIn },
    meta: {
      title: profile?.username || ig.username || "Instagram",
      handle: profile?.username || ig.username || "",
      avatar: null,
    },
  };
}

/** Публикация медиа в Instagram. media — публичная ссылка (image/video). */
async function instagramPublish(accessToken, payload, externalId) {
  const res = await publishMedia(accessToken, externalId, {
    caption: payload.text || "",
    media: payload.media,
  });
  if (!res.ok) return res;
  return {
    ...res,
    externalId: res.mediaId,
    postUrl: res.url,
  };
}

/**
 * Ищем первый IG business-аккаунт среди страниц FB, доступных токену.
 * GET /me/accounts → страницы; у каждой может быть connected_instagram_account.id.
 */
async function findIgBusinessAccount(accessToken) {
  const url = new URL(`${GRAPH_BASE}/me/accounts`);
  url.searchParams.set("fields", "id,name,connected_instagram_account{id,username}");
  url.searchParams.set("access_token", accessToken);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const data = await res.json().catch(() => null);
    const pages = Array.isArray(data?.data) ? data.data : [];
    for (const page of pages) {
      const ig = page?.connected_instagram_account;
      if (ig && typeof ig.id === "string") {
        return { id: ig.id, username: ig.username || page.name || "" };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Реестр адаптеров. Ключ = network (он же channels.network и oauth_tokens.provider).
 *  - finalizeTokens(tokens) → { ok, externalId, meta, tokens? } — пост-обработка на колбэке;
 *  - publish(accessToken, payload, externalId) → нормализованный результат публикации;
 *  - refresh: true, если access_token истекает и нужен авто-рефреш (задача воркера).
 */
export const SOCIAL_ADAPTERS = {
  youtube: {
    id: "youtube",
    label: "YouTube",
    refresh: true,
    composerSupported: providerSupportsOperation("youtube", "livePublish"),
    retryPolicy: "reconcile_before_retry",
    finalizeTokens: youtubeFinalize,
    publish: youtubePublish,
    reconcile: (accessToken, operation) => reconcileUploadSession(
      accessToken,
      operation.providerOperationId,
      operation.totalBytes,
    ),
  },
  instagram: {
    id: "instagram",
    label: "Instagram",
    refresh: true,
    composerSupported: providerSupportsOperation("instagram", "livePublish"),
    retryPolicy: "reconcile_before_retry",
    finalizeTokens: instagramFinalize,
    publish: instagramPublish,
    reconcile: (accessToken, operation) => reconcileMediaCreation(
      accessToken,
      operation.providerOperationId,
    ),
  },
  // Export-only until written official access and a documented partner contract exist.
  // Registering the adapter gives API/worker code one fail-closed contract instead of a
  // network-specific fallback that could accidentally report a live success.
  tenchat: TENCHAT_ADAPTER,
};

for (const adapter of Object.values(SOCIAL_ADAPTERS)) assertFutureProviderAdapter(adapter);

export function getAdapter(network) {
  return SOCIAL_ADAPTERS[network] ?? null;
}

/* ------------------------------------------------------------- витрина (UI) */

/**
 * Сети для пикера в настройках. status:
 *  - 'oauth'   — подключение в один клик через OAuth (кнопка активна);
 *  - 'soon'    — заглушка «Скоро» (кнопка неактивна). X — бесплатно публиковать нельзя
 *                (с февр. 2026 бесплатный тариф закрыт), поэтому пока «скоро».
 */
export const NETWORK_CATALOG = [
  { id: "youtube", label: "YouTube", status: "oauth", hint: "Видео и Shorts" },
  { id: "instagram", label: "Instagram", status: "oauth", hint: "Посты и Reels" },
  { id: "x", label: "X (Twitter)", status: "soon", hint: "Скоро" },
  { id: "tiktok", label: "TikTok", status: "soon", hint: "Скоро" },
  { id: "linkedin", label: "LinkedIn", status: "soon", hint: "Скоро" },
];
