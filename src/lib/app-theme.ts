export const APP_THEME_COOKIE = "aurora_app_theme";

export const APP_THEME_PREFERENCES = ["light", "dark", "system"] as const;

export type AppThemePreference = (typeof APP_THEME_PREFERENCES)[number];
export type ResolvedAppTheme = Exclude<AppThemePreference, "system">;

export function normalizeAppThemePreference(value: unknown): AppThemePreference {
  return APP_THEME_PREFERENCES.includes(value as AppThemePreference)
    ? value as AppThemePreference
    : "dark";
}

export function resolveAppTheme(
  preference: AppThemePreference,
  systemPrefersDark: boolean,
): ResolvedAppTheme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

export function appThemeColor(theme: ResolvedAppTheme): string {
  return theme === "dark" ? "#070a10" : "#ffffff";
}
