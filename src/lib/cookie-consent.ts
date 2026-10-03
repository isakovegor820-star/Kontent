/**
 * Выбор пользователя по файлам cookie — в одном месте.
 *
 * Причина отдельного модуля: решение о cookie читают три разных потребителя —
 * баннер (записывает выбор), клиентская аналитика (спрашивает разрешение перед
 * инициализацией) и сервер (показывает состояние в интерфейсе). Разойдись они
 * в имени cookie или в формате значения — согласие перестанет работать молча.
 *
 * Cookie намеренно доступна скриптам страницы (без HttpOnly): инициализация
 * аналитики на клиенте обязана прочитать выбор до первого сетевого запроса.
 * Персональных данных в ней нет — только категории и версия текста баннера.
 */

/** Имя cookie выбора. Меняется здесь и только здесь. */
export const COOKIE_CONSENT_NAME = "aurora_cookie_consent";

/** Срок хранения выбора: 180 дней. После — спрашиваем заново. */
export const COOKIE_CONSENT_MAX_AGE_SECONDS = 15_552_000;

/**
 * Версия текста баннера. Растёт вместе с утверждённой редакцией:
 * по ней видно, на каком тексте пользователь сделал выбор.
 */
export const COOKIE_CONSENT_VERSION = "draft-2026-10";

/** Категории cookie: необходимые не выключаются, аналитика и реклама — по выбору. */
export const COOKIE_CATEGORIES = ["necessary", "analytics", "marketing"] as const;
export type CookieCategory = (typeof COOKIE_CATEGORIES)[number];

export type CookieConsentDecision = "all" | "necessary" | "custom";

export type CookieConsent = {
  decision: CookieConsentDecision;
  categories: Record<CookieCategory, boolean>;
  version: string;
  /** Момент выбора в ISO-формате — доказательство информирования. */
  decidedAt: string;
};

const MINIMAL: Record<CookieCategory, boolean> = {
  necessary: true,
  analytics: false,
  marketing: false,
};

const ALL: Record<CookieCategory, boolean> = {
  necessary: true,
  analytics: true,
  marketing: true,
};

/** Набор категорий для готового решения баннера. */
export function consentCategories(decision: CookieConsentDecision): Record<CookieCategory, boolean> {
  if (decision === "all") return { ...ALL };
  return { ...MINIMAL };
}

/** Собирает запись о согласии: решение, категории, версия текста, время. */
export function buildConsent(
  decision: CookieConsentDecision,
  options: { categories?: Partial<Record<CookieCategory, boolean>>; now?: Date; version?: string } = {},
): CookieConsent {
  const base = consentCategories(decision);
  const categories: Record<CookieCategory, boolean> = {
    // Необходимые не могут быть выключены: без них сервис не работает.
    necessary: true,
    analytics: options.categories?.analytics ?? base.analytics,
    marketing: options.categories?.marketing ?? base.marketing,
  };
  return {
    decision,
    categories,
    version: options.version ?? COOKIE_CONSENT_VERSION,
    decidedAt: (options.now ?? new Date()).toISOString(),
  };
}

/** Разбирает значение cookie. Неизвестный или битый формат — это «выбора нет». */
export function parseConsent(raw: string | null | undefined): CookieConsent | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw));
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Partial<CookieConsent>;
    const categories = value.categories as Record<string, unknown> | undefined;
    if (!categories || typeof categories !== "object") return null;
    return {
      decision: value.decision === "all" || value.decision === "custom" ? value.decision : "necessary",
      categories: {
        necessary: true,
        analytics: categories.analytics === true,
        marketing: categories.marketing === true,
      },
      version: typeof value.version === "string" ? value.version : "unknown",
      decidedAt: typeof value.decidedAt === "string" ? value.decidedAt : "",
    };
  } catch {
    return null;
  }
}

/** Сериализует выбор в значение cookie. */
export function serializeConsent(consent: CookieConsent): string {
  return encodeURIComponent(JSON.stringify(consent));
}

/** Читает cookie из строки `document.cookie` (клиент) или заголовка Cookie (сервер). */
export function readConsentFromCookieString(cookieString: string | null | undefined): CookieConsent | null {
  if (!cookieString) return null;
  for (const part of cookieString.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== COOKIE_CONSENT_NAME) continue;
    return parseConsent(part.slice(separator + 1).trim());
  }
  return null;
}

/** Разрешена ли аналитика: до выбора — нет. Именно это читает инициализация Sentry. */
export function hasAnalyticsConsent(consent: CookieConsent | null): boolean {
  return consent?.categories.analytics === true;
}

/** Строка атрибутов cookie: общая для записи из браузера и из тестов. */
export function consentCookieAttributes(secure: boolean): string {
  return `Max-Age=${COOKIE_CONSENT_MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secure ? "; Secure" : ""}`;
}
