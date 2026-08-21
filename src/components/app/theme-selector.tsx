"use client";

import { useAppTheme } from "@/components/app/theme-provider";
import type { AppThemePreference } from "@/lib/app-theme";
import { cn } from "@/lib/utils";

const OPTIONS: { value: AppThemePreference; label: string; title: string }[] = [
  { value: "light", label: "Светлая", title: "Использовать светлую тему" },
  { value: "dark", label: "Тёмная", title: "Использовать тёмную тему" },
  { value: "system", label: "Система", title: "Использовать тему устройства" },
];

export function AppThemeSelector() {
  const { preference, setPreference } = useAppTheme();

  return (
    <fieldset>
      <legend className="mb-2 px-1 text-[12px] font-bold tracking-[0.04em] text-text-3 uppercase">
        Оформление
      </legend>
      <div className="grid grid-cols-3 gap-1 rounded-sm bg-surface-inset p-1">
        {OPTIONS.map((option) => {
          const selected = preference === option.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              title={option.title}
              onClick={() => setPreference(option.value)}
              className={cn(
                "min-h-10 rounded-xs px-1.5 text-center text-[12px] font-semibold transition-colors duration-150",
                selected
                  ? "bg-surface text-brand shadow-soft"
                  : "text-text-3 hover:bg-surface/70 hover:text-text",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
