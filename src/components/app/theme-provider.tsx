"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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
  saving: boolean;
  error: string;
  retry: () => void;
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
  const [prefersDark, setPrefersDark] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AppThemePreference | null>(null);
  const running = useRef(false);

  const persist = useCallback(async () => {
    if (running.current || pending.current == null) return;
    running.current = true;
    setSaving(true);
    setError("");
    try {
      while (pending.current != null) {
        const theme = pending.current;
        pending.current = null;
        try {
          const response = await fetch("/api/settings/account-profile", {
            method: "PATCH", headers: { "content-type": "application/json" },
            body: JSON.stringify({ theme }), keepalive: true,
          });
          const body = await response.json();
          if (!response.ok || !body?.ok) throw new Error("theme_save_failed");
        } catch {
          pending.current ??= theme;
          setError("Тема применена на этом устройстве, но не сохранена в аккаунте.");
          break;
        }
      }
    } finally {
      running.current = false;
      setSaving(false);
    }
  }, []);

  const setPreference = useCallback((nextPreference: AppThemePreference) => {
    setPreferenceState(nextPreference);
    writeThemeCookie(nextPreference);
    pending.current = nextPreference;
    void persist();
  }, [persist]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setPrefersDark(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  const resolvedTheme = resolveAppTheme(preference, prefersDark);

  useEffect(() => {
    updateBrowserThemeColor(preference === "system" ? resolvedTheme : preference);
  }, [preference, resolvedTheme]);

  const value = useMemo(() => ({ preference, setPreference, saving, error, retry: () => { void persist(); } }), [preference, setPreference, saving, error, persist]);

  return (
    <AppThemeContext.Provider value={value}>
      <div className="app-v3" data-theme={resolvedTheme} data-theme-preference={preference}>{children}</div>
    </AppThemeContext.Provider>
  );
}

export function useAppTheme() {
  const value = useContext(AppThemeContext);
  if (!value) throw new Error("useAppTheme must be used inside AppThemeProvider");
  return value;
}
