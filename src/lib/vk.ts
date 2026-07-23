// Клиент VK API для публикации и аналитики (Д.4).
//
// Модель токена (волна 1): РУЧНОЙ токен сообщества — админ создаёт ключ в
// «Управление → Работа с API» с правом «Стена», вставляет его при подключении канала.
// Токен бессрочный, не требует бизнес-верификации и одобрения VK. OAuth через VK ID —
// следующая волна (тот же wall.post, но источник токена другой; конверт и паблишинг
// уже готовы его принять).
//
// Чистые парсеры (parseGroup/parsePostStats/buildOwnerId/vkPostUrl) вынесены отдельно
// и покрыты тестами: формат ответов VK менялся между версиями API, поэтому парсим защитно.

const VK_API_BASE = "https://api.vk.com/method";
const VK_API_VERSION = "5.199";
const VK_TIMEOUT_MS = 20_000;

export interface VkGroup {
  groupId: number;
  name: string;
  screenName: string;
  membersCount: number | null;
}

export interface VkPostMetrics {
  views: number | null;
  reactions: number | null; // лайки VK — ближайший аналог реакций TG
  reposts: number | null;
  comments: number | null;
}

export type VkResult<T> =
  | { ok: true; response: T }
  | { ok: false; errorCode: number; errorMsg: string };

/* ------------------------------------------------------------------ чистые */

/** owner_id записи сообщества в VK — отрицательный id группы. */
export function buildOwnerId(groupId: number): string {
  return `-${groupId}`;
}

/** Публичная ссылка на вышедший пост VK. */
export function vkPostUrl(groupId: number, postId: number): string {
  return `https://vk.com/wall-${groupId}_${postId}`;
}

// groups.getById в разных версиях API отдаёт то массив, то { groups: [...] }.
// Принимаем обе формы, иначе свежая версия API молча оставит канал без названия.
export function parseGroup(raw: unknown): VkGroup | null {
  const list = Array.isArray(raw)
    ? raw
    : (raw as { groups?: unknown[] } | null)?.groups;
  const g = Array.isArray(list) ? list[0] : null;
  if (!g || typeof g !== "object") return null;
  const grp = g as { id?: number; name?: string; screen_name?: string; members_count?: number };
  if (typeof grp.id !== "number") return null;
  return {
    groupId: grp.id,
    name: grp.name ?? "",
    screenName: grp.screen_name ?? "",
    membersCount: typeof grp.members_count === "number" ? grp.members_count : null,
  };
}

// wall.getById отдаёт пост с вложенными счётчиками { count }. Любое поле может
// отсутствовать — возвращаем null («недоступно»), а не 0.
export function parsePostStats(raw: unknown): VkPostMetrics | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as {
    views?: { count?: number };
    likes?: { count?: number };
    reposts?: { count?: number };
    comments?: { count?: number };
  };
  const num = (v: { count?: number } | undefined) =>
    typeof v?.count === "number" ? v.count : null;
  return {
    views: num(p.views),
    reactions: num(p.likes),
    reposts: num(p.reposts),
    comments: num(p.comments),
  };
}

/* ------------------------------------------------------------------- сеть */

/** Один эгресс к VK API: form-encoded POST, таймаут, разбор {response}/{error}. */
export async function vkApi<T>(
  method: string,
  params: Record<string, string | number>,
  token: string,
): Promise<VkResult<T>> {
  const body = new URLSearchParams({ v: VK_API_VERSION, access_token: token });
  for (const [k, val] of Object.entries(params)) body.set(k, String(val));
  try {
    const r = await fetch(`${VK_API_BASE}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(VK_TIMEOUT_MS),
    });
    const data = (await r.json()) as
      | { response?: T; error?: { error_code: number; error_msg: string } };
    if (data.error) {
      return { ok: false, errorCode: data.error.error_code, errorMsg: data.error.error_msg };
    }
    return { ok: true, response: data.response as T };
  } catch (err) {
    return { ok: false, errorCode: -1, errorMsg: String((err as Error)?.message || err) };
  }
}

/**
 * Валидирует токен сообщества и сразу определяет группу, к которой он выписан:
 * groups.getById без group_id возвращает сообщество, доступное токену.
 * null — токен невалиден/отозван или сообщество не определяется.
 */
export async function resolveGroupByToken(token: string): Promise<VkGroup | null> {
  const res = await vkApi<unknown>("groups.getById", { fields: "members_count" }, token);
  if (!res.ok) return null;
  return parseGroup(res.response);
}

/** Число подписчиков сообщества (для суточного снимка аналитики). */
export async function vkMembersCount(token: string, groupId: number): Promise<number | null> {
  const res = await vkApi<unknown>(
    "groups.getById",
    { group_id: String(groupId), fields: "members_count" },
    token,
  );
  if (!res.ok) return null;
  return parseGroup(res.response)?.membersCount ?? null;
}

/** Публикация записи от имени сообщества. post_id — для ссылки и аналитики. */
export async function vkWallPost(
  token: string,
  groupId: number,
  message: string,
): Promise<{ ok: true; postId: number } | { ok: false; errorMsg: string }> {
  const res = await vkApi<{ post_id?: number }>(
    "wall.post",
    { owner_id: buildOwnerId(groupId), from_group: 1, message },
    token,
  );
  if (res.ok && typeof res.response?.post_id === "number") {
    return { ok: true, postId: res.response.post_id };
  }
  return { ok: false, errorMsg: res.ok ? "VK не вернул post_id" : res.errorMsg };
}

/** Метрики вышедшего поста VK (просмотры/лайки/репосты/комментарии). */
export async function vkPostStats(
  token: string,
  groupId: number,
  postId: number,
): Promise<VkPostMetrics | null> {
  const res = await vkApi<unknown[]>(
    "wall.getById",
    { posts: `${buildOwnerId(groupId)}_${postId}` },
    token,
  );
  if (!res.ok || !Array.isArray(res.response)) return null;
  return parsePostStats(res.response[0]);
}
