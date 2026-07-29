// Клиент YouTube Data API v3 (Волна 2, Фаза 1). Публикация видео + резолв канала.
//
// Почему .mjs, а не .ts: этот модуль импортирует И TS-роуты (@/lib/youtube.mjs),
// И .mjs-воркер (./src/lib/youtube.mjs) — как token-crypto.mjs/channel-profile.mjs.
// Воркер — plain Node без TS-загрузчика, поэтому общий код живёт в .mjs. Один модуль —
// ноль дублирования между воркером и роутами. Чистые парсеры покрыты vitest.
//
// Модель доступа: OAuth 2.0 (access_token из oauth_tokens, refresh_token бессрочный
// при access_type=offline). Публикация видео — resumable upload (init → PUT тела).
//
// КВОТА: 10 000 юнитов/день на проект, 1 аплоад = 1600 юнитов → ~6 видео/день.
// При исчерпании Google вернёт 403 quotaExceeded — пробрасываем код, чтобы воркер
// показал человеку понятную причину и перенёс публикацию на завтра.

const API_BASE = "https://www.googleapis.com";
const UPLOAD_BASE = "https://www.googleapis.com";
const TIMEOUT_MS = 30_000;

/* ------------------------------------------------------------------ чистые */

/**
 * Достаёт байты медиа из разных источников: Buffer/Uint8Array (загрузка из кабинета),
 * http(s)-URL (ссылка на файл) или data:URL. Возвращает { buffer, contentType }.
 */
export async function resolveMediaBytes(media) {
  if (!media) throw new Error("нет медиа для загрузки");

  // Уже байты.
  if (media instanceof Uint8Array) {
    return { buffer: Buffer.from(media), contentType: media.type || "video/mp4" };
  }

  const url = typeof media === "string" ? media : media.url;
  if (!url) throw new Error("нет источника видео (url/buffer)");

  if (url.startsWith("data:")) {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
    if (!m) throw new Error("некорректный data:URL");
    return { buffer: Buffer.from(m[2], "base64"), contentType: m[1] };
  }

  if (/^https?:\/\//i.test(url)) {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`не удалось скачать видео: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { buffer: buf, contentType: res.headers.get("content-type") || "video/mp4" };
  }

  throw new Error("неподдерживаемый источник видео");
}

/** Разбор списка каналов (channels?mine=true). Берём первый, защитно. */
export function parseChannel(raw) {
  const item = Array.isArray(raw?.items) ? raw.items[0] : null;
  if (!item || typeof item !== "object" || typeof item.id !== "string") return null;
  const snippet = item.snippet ?? {};
  const thumbs = snippet.thumbnails ?? {};
  const avatar =
    thumbs.medium?.url || thumbs.default?.url || thumbs.high?.url || null;
  return {
    id: item.id,
    title: typeof snippet.title === "string" ? snippet.title : "",
    handle: typeof snippet.customUrl === "string" ? snippet.customUrl.replace(/^@/, "") : "",
    avatar,
  };
}

/** Разбор ответа resumable upload: id вышедшего видео. */
export function parseUploadResult(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string") return null;
  return {
    videoId: raw.id,
    url: `https://www.youtube.com/watch?v=${raw.id}`,
  };
}

/* ------------------------------------------------------------------- сеть */

/**
 * Резолвит канал текущего пользователя (mine=true): id, название, аватар.
 * null — токен невалиден/отозван или канал не определяется.
 */
export async function resolveChannel(accessToken) {
  const url = new URL(`${API_BASE}/youtube/v3/channels`);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("mine", "true");
  url.searchParams.set("maxResults", "1");
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return parseChannel(await res.json());
  } catch {
    return null;
  }
}

/**
 * Публикует видео на канал (resumable upload, упрощённо: init → один PUT всего тела).
 * Для файлов до сотен МБ одного PUT достаточно; при обрыве Google вернёт ошибку —
 * воркер повторит задачу целиком.
 *
 * @returns {{ ok:true, videoId:string, url:string } | { ok:false, reason:string, code?:string }}
 */
export async function uploadVideo(accessToken, opts) {
  const { title, description = "", privacyStatus = "private", media } = opts;

  let body;
  let contentType;
  try {
    const resolved = await resolveMediaBytes(media);
    body = resolved.buffer;
    contentType = resolved.contentType;
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }

  // 1) Init: метаданные + X-Upload-Content-* → получаем Location для загрузки тела.
  const initUrl = new URL(`${UPLOAD_BASE}/upload/youtube/v3/videos`);
  initUrl.searchParams.set("part", "snippet,status");
  initUrl.searchParams.set("uploadType", "resumable");

  const metadata = {
    snippet: { title, description, categoryId: "22" },
    status: { privacyStatus },
  };

  let location;
  try {
    const initRes = await fetch(initUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-length": String(body.length),
        "x-upload-content-type": contentType,
      },
      body: JSON.stringify(metadata),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!initRes.ok) {
      return { ok: false, reason: await errorReason(initRes), code: await errorCode(initRes) };
    }
    location = initRes.headers.get("location");
    if (!location) return { ok: false, reason: "YouTube не вернул location для загрузки" };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }

  // 2) PUT тела видео по Location.
  try {
    const putRes = await fetch(location, {
      method: "PUT",
      headers: { "content-type": contentType, "content-length": String(body.length) },
      body,
      signal: AbortSignal.timeout(120_000),
    });
    if (!putRes.ok) {
      return { ok: false, reason: await errorReason(putRes), code: await errorCode(putRes) };
    }
    const parsed = parseUploadResult(await putRes.json());
    if (!parsed) return { ok: false, reason: "YouTube не вернул id видео" };
    return { ok: true, videoId: parsed.videoId, url: parsed.url };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}

/* ------------------------------------------------------------- разбор ошибок */

async function errorReason(res) {
  try {
    const data = await res.clone().json();
    const msg = data?.error?.message;
    if (typeof msg === "string") return `HTTP ${res.status}: ${msg}`;
  } catch {
    /* тело не JSON — падаем на статус */
  }
  return `YouTube ответил HTTP ${res.status}`;
}

async function errorCode(res) {
  try {
    const data = await res.clone().json();
    const reasons = data?.error?.errors;
    if (Array.isArray(reasons) && reasons[0]?.reason) return String(reasons[0].reason);
  } catch {
    /* ignore */
  }
  return undefined;
}
