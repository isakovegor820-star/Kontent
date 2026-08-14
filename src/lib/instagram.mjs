// Клиент Instagram Graph API (Волна 2, Фаза 2). Публикация медиа + резолв аккаунта.
//
// Почему .mjs: импортируют И TS-роуты, И .mjs-воркер (как youtube.mjs/token-crypto.mjs).
//
// Модель доступа: OAuth через Facebook Login. Короткоживущий токен (≈1–2 ч) меняем на
// long-lived (60 дней) сразу при подключении; воркер суточной задачей продлевает его,
// пока не истечёт. Публикация — двухшаговые «контейнеры»: создаём контейнер под медиа,
// затем публикуем его. Лимит Instagram — ~25 постов/24 ч.
//
// Предварительные условия (важно для «перешёл и работает»):
//  - у пользователя Instagram Business/Creator, привязанный к Facebook Page;
//  - наше Meta-приложение прошло App Review на instagram_content_publish +
//    pages_manage_posts + pages_read_engagement (иначе публикация только для ролей приложения).

import {
  classifiedFailure,
  definiteFailure,
  deliveryUnknown,
  PROVIDER_DELIVERY_OUTCOMES,
} from "./social-provider-contract.mjs";

const META_GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || "v24.0";
const GRAPH_BASE = process.env.META_GRAPH_API_BASE || `https://graph.facebook.com/${META_GRAPH_VERSION}`;
const TIMEOUT_MS = 30_000;

/* ------------------------------------------------------------------ чистые */

/** Разбор профиля IG-пользователя (GET /me?fields=id,username,media_count). */
export function parseIgUser(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string") return null;
  return {
    id: raw.id,
    username: typeof raw.username === "string" ? raw.username : "",
    mediaCount: typeof raw.media_count === "number" ? raw.media_count : null,
  };
}

/** Разбор ответа публикации (POST /{id}/media_publish → { id }). */
export function parsePublishResult(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string") return null;
  return { mediaId: raw.id, url: `https://www.instagram.com/p/${raw.id}/` };
}

/**
 * Определяет тип контейнера по медиа: видео (Reels) или изображение.
 * media: string(url) | { url, type? } | { videoUrl } | { imageUrl }.
 */
export function detectMediaType(media) {
  if (!media) return null;
  if (typeof media === "string") {
    return /\.mp4($|\?)/i.test(media) || /video/i.test(media) ? "video" : "image";
  }
  if (media.videoUrl) return "video";
  if (media.imageUrl) return "image";
  if (media.url) return /\.mp4($|\?)/i.test(media.url) ? "video" : "image";
  return null;
}

/* ------------------------------------------------------------------- сеть */

/**
 * Меняет короткоживущий токен Facebook Login на long-lived (60 дней).
 * Возвращает { accessToken, expiresIn } или null.
 */
export async function exchangeLongLivedToken({ clientId, clientSecret, shortToken }) {
  const url = new URL(`${GRAPH_BASE}/oauth/access_token`);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("client_secret", clientSecret);
  url.searchParams.set("fb_exchange_token", shortToken);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const data = await res.json().catch(() => null);
    if (!res.ok || typeof data?.access_token !== "string") return null;
    return {
      accessToken: data.access_token,
      expiresIn: typeof data.expires_in === "number" ? data.expires_in : null,
    };
  } catch {
    return null;
  }
}

/**
 * Резолвит IG business-аккаунт по long-lived токену.
 * ВАЖНО: токен Facebook Login выдаётся для FB-пользователя; IG user id получаем через
 * /me?fields=instagram_business_account (страница) → либо напрямую, если токен IG.
 * Здесь ожидаем, что на колбэке уже выбран IG business account id (см. адаптер).
 */
export async function resolveIgUser(accessToken, igUserId) {
  const url = new URL(`${GRAPH_BASE}/${igUserId}`);
  url.searchParams.set("fields", "id,username,media_count");
  url.searchParams.set("access_token", accessToken);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    return parseIgUser(await res.json());
  } catch {
    return null;
  }
}

/**
 * Публикует медиа (изображение или видео/Reels) в Instagram.
 * caption — текст поста. media — url изображения/видео (публично доступный).
 *
 * @returns {{ ok:true, mediaId:string, url:string } | { ok:false, reason:string, code?:string }}
 */
export async function publishMedia(accessToken, igUserId, { caption = "", media }) {
  const type = detectMediaType(media);
  const mediaUrl = typeof media === "string" ? media : media.videoUrl || media.imageUrl || media.url;
  if (!type || !mediaUrl) {
    return definiteFailure("instagram_media_required");
  }

  // 1) Создаём контейнер.
  const containerUrl = new URL(`${GRAPH_BASE}/${igUserId}/media`);
  if (type === "video") {
    containerUrl.searchParams.set("video_url", mediaUrl);
    containerUrl.searchParams.set("media_type", "REELS");
  } else {
    containerUrl.searchParams.set("image_url", mediaUrl);
  }
  if (caption) containerUrl.searchParams.set("caption", caption);
  containerUrl.searchParams.set("access_token", accessToken);

  let creationId;
  try {
    const cRes = await fetch(containerUrl, { method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const cData = await cRes.json().catch(() => null);
    if (!cRes.ok || typeof cData?.id !== "string") {
      return graphFailure(cRes.status, cData, "instagram_container_create_failed");
    }
    creationId = cData.id;
  } catch (err) {
    return definiteFailure("instagram_container_create_failed", {
      code: safeErrorCode(err),
      retryable: true,
    });
  }

  // 2) Публикуем контейнер.
  const publishUrl = new URL(`${GRAPH_BASE}/${igUserId}/media_publish`);
  publishUrl.searchParams.set("creation_id", creationId);
  publishUrl.searchParams.set("access_token", accessToken);
  try {
    const pRes = await fetch(publishUrl, { method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const pData = await pRes.json().catch(() => null);
    if (!pRes.ok) {
      return graphFailure(pRes.status, pData, "instagram_media_publish_failed", creationId);
    }
    const parsed = parsePublishResult(pData);
    if (!parsed) return deliveryUnknown(creationId, "instagram_publish_response_missing_media_id");
    return {
      ok: true,
      outcome: PROVIDER_DELIVERY_OUTCOMES.SUCCESS,
      mediaId: parsed.mediaId,
      url: parsed.url,
      providerOperationId: creationId,
      retryable: false,
    };
  } catch {
    return deliveryUnknown(creationId, "instagram_media_publish_delivery_unknown");
  }
}

function graphFailure(status, data, reason, providerOperationId = null) {
  const providerCode = data?.error?.code;
  const outcome = status === 401 || status === 403 || providerCode === 190
    ? PROVIDER_DELIVERY_OUTCOMES.AUTH_FAILED
    : status === 429 || providerCode === 4 || providerCode === 17 || providerCode === 32
      ? PROVIDER_DELIVERY_OUTCOMES.RATE_LIMITED
      : PROVIDER_DELIVERY_OUTCOMES.DEFINITE_FAILURE;
  return classifiedFailure(outcome, reason, {
    code: data?.error?.type || (providerCode ? `graph_${providerCode}` : `http_${status}`),
    providerOperationId,
    retryable: outcome === PROVIDER_DELIVERY_OUTCOMES.RATE_LIMITED || status >= 500,
  });
}

function safeErrorCode(error) {
  if (error && typeof error === "object" && "code" in error && error.code) return String(error.code).slice(0, 80);
  return error instanceof Error ? error.name : "provider_error";
}

/** Read-only container probe. FINISHED alone is not claimed as published without a media ID. */
export async function reconcileMediaCreation(accessToken, creationId) {
  const url = new URL(`${GRAPH_BASE}/${creationId}`);
  url.searchParams.set("fields", "status_code,status");
  url.searchParams.set("access_token", accessToken);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await response.json().catch(() => null);
    if (!response.ok) return { status: "unresolved", code: body?.error?.type || `http_${response.status}` };
    return {
      status: body?.status_code === "ERROR" ? "failed" : "unresolved",
      providerState: typeof body?.status_code === "string" ? body.status_code : null,
    };
  } catch {
    return { status: "unresolved", code: "status_probe_failed" };
  }
}
