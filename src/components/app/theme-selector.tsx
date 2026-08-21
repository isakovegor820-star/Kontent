"use client";

import { useAppTheme } from "@/components/app/theme-provider";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { nextAppThemePreference } from "@/lib/app-theme";

export function AppThemeSelector() {
  const { preference, setPreference } = useAppTheme();
  const nextPreference = nextAppThemePreference(preference);
  const label = nextPreference === "light"
    ? "Включить светлую тему"
    : "Включить тёмную тему";

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={() => setPreference(nextPreference)}
      aria-label={label}
      title={label}
    >
      {preference === "dark" ? (
        <Sun className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
      ) : (
        <Moon className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
      )}
    </Button>
  );
}
