// Универсальные источники конкурентов. UI/API/воркер используют один и тот же реестр:
// добавление следующей сети не требует нового формата карточки или отдельного парсера URL.

export const MAX_COMPETITORS = 20;
export const COMPETITOR_NETWORKS = ["tg", "instagram"] as const;
export type CompetitorNetwork = (typeof COMPETITOR_NETWORKS)[number];

export const COMPETITOR_PROVIDERS = {
  tg: {
    label: "Telegram",
    inputLabel: "Ссылка или имя Telegram-канала",
    placeholder: "t.me/durov или @durov",
    hint: "Только публичные каналы, которые открываются без вступления.",
  },
  instagram: {
    label: "Instagram",
    inputLabel: "Ссылка или имя Instagram-аккаунта",
    placeholder: "instagram.com/nasa или @nasa",
    hint: "Через официальный Meta API доступны публичные Business- и Creator-аккаунты.",
  },
} as const satisfies Record<CompetitorNetwork, {
  label: string;
  inputLabel: string;
  placeholder: string;
  hint: string;
}>;

export function isCompetitorNetwork(value: unknown): value is CompetitorNetwork {
  return typeof value === "string" && (COMPETITOR_NETWORKS as readonly string[]).includes(value);
}

/**
 * Достаёт @username публичного канала из ссылки/строки. Отсекает приватные ссылки
 * (joinchat, t.me/+hash) — по ним открытых данных нет. Возвращает handle или код ошибки.
 */
export function parseHandle(input: string): { handle?: string; error?: string } {
  let s = String(input ?? "").trim();
  if (!s) return { error: "empty" };

  s = s.replace(/^https?:\/\//i, "").replace(/^(t\.me|telegram\.me)\//i, "");
  s = s.replace(/^s\//i, ""); // t.me/s/<канал> — превью-ссылка
  s = s.replace(/^@/, "");
  s = s.split(/[/?#]/)[0].trim().toLowerCase();

  if (!s || s.startsWith("+") || s === "joinchat") return { error: "private" };
  if (!/^[a-z][a-z0-9_]{3,31}$/.test(s)) return { error: "bad" };
  return { handle: s };
}

export function parseInstagramHandle(input: string): { handle?: string; error?: string } {
  let s = String(input ?? "").trim();
  if (!s) return { error: "empty" };

  s = s
    .replace(/^https?:\/\//i, "")
    .replace(/^(www\.)?instagram\.com\//i, "")
    .replace(/^@/, "");
  s = s.split(/[/?#]/)[0].trim().toLowerCase();

  if (!s || ["accounts", "explore", "p", "reel", "reels", "stories"].includes(s)) {
    return { error: "bad" };
  }
  if (!/^[a-z0-9_](?:[a-z0-9._]{0,28}[a-z0-9_])?$/.test(s) || s.includes("..")) {
    return { error: "bad" };
  }
  return { handle: s };
}

export function parseCompetitorSource(
  network: CompetitorNetwork,
  input: string,
): { handle?: string; error?: string } {
  return network === "instagram" ? parseInstagramHandle(input) : parseHandle(input);
}

export function competitorProfileUrl(network: CompetitorNetwork, handle: string): string {
  return network === "instagram"
    ? `https://www.instagram.com/${encodeURIComponent(handle)}/`
    : `https://t.me/${encodeURIComponent(handle)}`;
}

export function competitorPostUrl(
  network: CompetitorNetwork,
  handle: string,
  externalPostId?: string | number | null,
  permalink?: string | null,
): string {
  if (permalink && /^https:\/\/(?:www\.)?(?:instagram\.com|t\.me)\//i.test(permalink)) {
    return permalink;
  }
  if (network === "instagram") return competitorProfileUrl(network, handle);
  return externalPostId == null
    ? competitorProfileUrl(network, handle)
    : `https://t.me/${encodeURIComponent(handle)}/${encodeURIComponent(String(externalPostId))}`;
}

/** Человеческий текст ошибки разбора ссылки — для интерфейса. */
export function handleErrorText(error?: string): string {
  switch (error) {
    case "empty":
      return "Вставь ссылку на Telegram-канал — например, t.me/durov или @durov.";
    case "private":
      return "Это приватная ссылка. Досье собирается только по публичным каналам — их видно без вступления.";
    case "bad":
      return "Не похоже на адрес канала. Проверь ссылку: t.me/имя_канала или @имя_канала.";
    default:
      return "Не получилось разобрать ссылку. Попробуй ещё раз.";
  }
}

export function sourceErrorText(network: CompetitorNetwork, error?: string): string {
  if (network === "tg") return handleErrorText(error);
  switch (error) {
    case "empty":
      return "Вставь ссылку или имя Instagram-аккаунта — например, instagram.com/nasa или @nasa.";
    case "bad":
      return "Не похоже на Instagram-аккаунт. Нужна ссылка на профиль или имя вида @nasa.";
    default:
      return "Не получилось разобрать Instagram-аккаунт. Проверь адрес и попробуй ещё раз.";
  }
}
