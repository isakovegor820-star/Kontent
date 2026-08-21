"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  APP_THEME_COOKIE,
  appThemeColor,
  resolveAppTheme,
  type AppThemePreference,
} from "@/lib/app-theme";

type AppThemeContextValue = {
  preference: AppThemePreference;
  setPreference: (preference: AppThemePreference) => void;
};

const AppThemeContext = createContext<AppThemeContextValue | null>(null);

function writeThemeCookie(preference: AppThemePreference) {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${APP_THEME_COOKIE}=${preference}; Max-Age=31536000; Path=/; SameSite=Lax${secure}`;
}

function updateBrowserThemeColor(preference: AppThemePreference, systemPrefersDark: boolean) {
  const theme = resolveAppTheme(preference, systemPrefersDark);
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  meta?.setAttribute("content", appThemeColor(theme));
}

export function AppThemeProvider({
  children,
  initialPreference,
}: {
  children: React.ReactNode;
  initialPreference: AppThemePreference;
}) {
  const [preference, setPreferenceState] = useState(initialPreference);

  const setPreference = useCallback((nextPreference: AppThemePreference) => {
    setPreferenceState(nextPreference);
    writeThemeCookie(nextPreference);
  }, []);

  useEffect(() => {
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    const syncBrowserChrome = () => updateBrowserThemeColor(preference, colorScheme.matches);
    syncBrowserChrome();

    if (preference !== "system") return;
    colorScheme.addEventListener("change", syncBrowserChrome);
    return () => colorScheme.removeEventListener("change", syncBrowserChrome);
  }, [preference]);

  const value = useMemo(() => ({ preference, setPreference }), [preference, setPreference]);

  return (
    <AppThemeContext.Provider value={value}>
      <div className="app-v3" data-theme={preference}>{children}</div>
    </AppThemeContext.Provider>
  );
}

export function useAppTheme() {
  const value = useContext(AppThemeContext);
  if (!value) throw new Error("useAppTheme must be used inside AppThemeProvider");
  return value;
}
