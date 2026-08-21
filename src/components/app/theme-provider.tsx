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

function updateBrowserThemeColor(preference: AppThemePreference) {
  const theme = resolveAppTheme(preference);
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
    updateBrowserThemeColor(preference);
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
