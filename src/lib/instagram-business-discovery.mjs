// Read-only competitor ingestion through Meta's official Business Discovery field.
// No HTML scraping fallback: unsupported personal/private profiles must remain an honest error.

const DEFAULT_GRAPH_BASE = "https://graph.facebook.com/v24.0";

function finiteCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.round(count) : null;
}

function safeHttpsUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function normalizeInstagramBusinessDiscovery(payload) {
  const profile = payload?.business_discovery;
  if (!profile || typeof profile !== "object" || typeof profile.username !== "string") return null;

  const rawMedia = Array.isArray(profile.media?.data) ? profile.media.data : [];
  return {
    id: typeof profile.id === "string" ? profile.id : null,
    username: profile.username.toLowerCase(),
    name: typeof profile.name === "string" && profile.name.trim() ? profile.name.trim() : null,
    avatarUrl: safeHttpsUrl(profile.profile_picture_url),
    followersCount: finiteCount(profile.followers_count),
    mediaCount: finiteCount(profile.media_count),
    posts: rawMedia
      .filter((item) => item && typeof item.id === "string")
      .map((item) => ({
        id: item.id,
        text: typeof item.caption === "string" ? item.caption : null,
        permalink: safeHttpsUrl(item.permalink),
        postedAt: typeof item.timestamp === "string" ? item.timestamp : null,
        media: item.media_type === "VIDEO" || item.media_type === "REELS" ? "video" : "photo",
        thumbnailUrl: safeHttpsUrl(item.thumbnail_url) || safeHttpsUrl(item.media_url),
        likes: finiteCount(item.like_count),
        comments: finiteCount(item.comments_count),
      })),
  };
}

export async function fetchInstagramBusinessDiscovery({
  accessToken,
  ownAccountId,
  username,
  fetchImpl = fetch,
  graphBase = process.env.META_GRAPH_API_BASE || DEFAULT_GRAPH_BASE,
}) {
  if (!accessToken || !ownAccountId || !username) {
    return { ok: false, code: "instagram_connection_missing" };
  }
  const url = new URL(`${String(graphBase).replace(/\/$/, "")}/${encodeURIComponent(ownAccountId)}`);
  url.searchParams.set(
    "fields",
    `business_discovery.username(${username}){id,username,name,profile_picture_url,followers_count,media_count,media.limit(25){id,caption,comments_count,like_count,media_type,permalink,thumbnail_url,media_url,timestamp}}`,
  );
  url.searchParams.set("access_token", accessToken);

  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    const payload = await response.json().catch(() => null);
    const profile = normalizeInstagramBusinessDiscovery(payload);
    if (response.ok && profile) return { ok: true, profile };
    const apiCode = Number(payload?.error?.code);
    return {
      ok: false,
      code: apiCode === 190 ? "instagram_token_rejected" : "instagram_profile_unavailable",
    };
  } catch {
    return { ok: false, code: "instagram_network_error" };
  }
}

export function instagramDiscoveryErrorText(code) {
  switch (code) {
    case "instagram_connection_missing":
      return "Подключи Instagram Business/Creator в настройках каналов, чтобы читать конкурентов через Meta API.";
    case "instagram_token_rejected":
      return "Instagram отклонил доступ. Переподключи Business/Creator-аккаунт в настройках каналов.";
    case "instagram_network_error":
      return "Instagram временно не ответил. Запусти обновление ещё раз.";
    default:
      return "Профиль не найден. Meta API показывает только доступные Business/Creator-аккаунты; личные и закрытые профили не поддерживаются.";
  }
}
