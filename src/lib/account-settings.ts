export const ACCOUNT_LOCALES = ["ru", "en"] as const;
export const ACCOUNT_THEMES = ["light", "dark", "system"] as const;

export type AccountLocale = (typeof ACCOUNT_LOCALES)[number];
export type AccountTheme = (typeof ACCOUNT_THEMES)[number];

export const NOTIFICATION_EVENTS = [
  "publication_ready",
  "publication_result",
  "autopilot_plan",
  "limit_warning",
  "integration_problem",
  "security",
] as const;

export const NOTIFICATION_CHANNELS = ["inApp", "email", "telegram"] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export type NotificationPreferences = Record<
  NotificationEvent,
  Record<NotificationChannel, boolean>
>;

export type AccountProfile = {
  firstName: string;
  lastName: string;
  displayName: string;
  jobTitle: string;
  bio: string;
  phone: string;
  email: string;
  avatar: string;
  locale: AccountLocale;
  timezone: string;
  theme: AccountTheme;
};

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  publication_ready: { inApp: true, email: true, telegram: true },
  publication_result: { inApp: true, email: true, telegram: true },
  autopilot_plan: { inApp: true, email: false, telegram: true },
  limit_warning: { inApp: true, email: true, telegram: false },
  integration_problem: { inApp: true, email: true, telegram: true },
  security: { inApp: true, email: true, telegram: false },
};

const clean = (value: unknown, max: number) => String(value ?? "")
  .replace(/\s+/gu, " ")
  .trim()
  .slice(0, max);

export function normalizePhone(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/gu, "");
  const normalized = raw.startsWith("+")
    ? `+${digits}`
    : digits.length === 11 && digits.startsWith("8")
      ? `+7${digits.slice(1)}`
      : `+${digits}`;
  return /^\+[1-9][0-9]{7,14}$/u.test(normalized) ? normalized : null;
}

export function normalizeTimezone(value: unknown): string | null {
  const timezone = clean(value, 80);
  if (!timezone) return null;
  try {
    new Intl.DateTimeFormat("ru-RU", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return null;
  }
}

export function normalizeAccountProfile(
  value: unknown,
  fallback: Partial<AccountProfile> = {},
): AccountProfile {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const locale = ACCOUNT_LOCALES.includes(input.locale as AccountLocale)
    ? input.locale as AccountLocale
    : fallback.locale ?? "ru";
  const theme = ACCOUNT_THEMES.includes(input.theme as AccountTheme)
    ? input.theme as AccountTheme
    : fallback.theme ?? "system";
  const timezone = normalizeTimezone(input.timezone) ?? fallback.timezone ?? "Europe/Moscow";
  return {
    firstName: clean(input.firstName ?? fallback.firstName, 80),
    lastName: clean(input.lastName ?? fallback.lastName, 80),
    displayName: clean(input.displayName ?? fallback.displayName, 120),
    jobTitle: clean(input.jobTitle ?? fallback.jobTitle, 160),
    bio: clean(input.bio ?? fallback.bio, 1000),
    phone: normalizePhone(input.phone ?? fallback.phone) ?? "",
    email: clean(input.email ?? fallback.email, 254).toLowerCase(),
    avatar: clean(input.avatar ?? fallback.avatar, 1000),
    locale,
    timezone,
    theme,
  };
}

export type AccountProfileParseResult =
  | { ok: true; value: Omit<AccountProfile, "email" | "phone"> }
  | { ok: false; error: "bad_profile" | "bad_display_name" | "bad_timezone" | "bad_theme" | "bad_locale" };

export function parseAccountProfileUpdate(value: unknown): AccountProfileParseResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "bad_profile" };
  }
  const input = value as Record<string, unknown>;
  if (!ACCOUNT_LOCALES.includes(input.locale as AccountLocale)) return { ok: false, error: "bad_locale" };
  if (!ACCOUNT_THEMES.includes(input.theme as AccountTheme)) return { ok: false, error: "bad_theme" };
  if (!normalizeTimezone(input.timezone)) return { ok: false, error: "bad_timezone" };
  const profile = normalizeAccountProfile(input);
  if (!profile.displayName) return { ok: false, error: "bad_display_name" };
  return {
    ok: true,
    value: {
      firstName: profile.firstName,
      lastName: profile.lastName,
      displayName: profile.displayName,
      jobTitle: profile.jobTitle,
      bio: profile.bio,
      avatar: profile.avatar,
      locale: profile.locale,
      timezone: profile.timezone,
      theme: profile.theme,
    },
  };
}

export function normalizeNotificationPreferences(value: unknown): NotificationPreferences {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const result = structuredClone(DEFAULT_NOTIFICATION_PREFERENCES);
  for (const event of NOTIFICATION_EVENTS) {
    const eventInput = input[event];
    if (!eventInput || typeof eventInput !== "object" || Array.isArray(eventInput)) continue;
    for (const channel of NOTIFICATION_CHANNELS) {
      const candidate = (eventInput as Record<string, unknown>)[channel];
      if (typeof candidate === "boolean") result[event][channel] = candidate;
    }
  }
  return result;
}

export function isCompleteNotificationPreferences(value: unknown): value is NotificationPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return NOTIFICATION_EVENTS.every((event) => {
    const row = (value as Record<string, unknown>)[event];
    return Boolean(row && typeof row === "object" && !Array.isArray(row))
      && NOTIFICATION_CHANNELS.every((channel) => typeof (row as Record<string, unknown>)[channel] === "boolean");
  });
}
