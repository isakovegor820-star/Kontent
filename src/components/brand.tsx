"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

/* ---------------------------------------------------------------- ЛОГОТИП */
// Знак — замкнутый круг формулы продукта: разведка → ИИ → постинг → реакции.
// Разрыв в кольце + точка = цикл, который всё время «догоняет» сам себя.

export function Logo({ className, size = 32 }: { className?: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={cn("shrink-0", className)}
      role="img"
      aria-label="Аврора"
    >
      <defs>
        <linearGradient id="auroraLogo" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6366F1" />
          <stop offset="1" stopColor="#8B5CF6" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#auroraLogo)" />
      {/* Кольцо с разрывом — цикл */}
      <path
        d="M23 16a7 7 0 1 1-3.2-5.87"
        stroke="white"
        strokeWidth="2.4"
        strokeLinecap="round"
        fill="none"
      />
      {/* Точка — новая итерация, «уже умнее» */}
      <circle cx="22.4" cy="9.6" r="2.5" fill="white" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <Logo />
      <span className="text-[19px] font-extrabold tracking-tight text-text">Аврора</span>
    </span>
  );
}

/* ------------------------------------------------------- ПЕРЕКЛЮЧАТЕЛЬ ТЕМЫ */
// ТЗ 7.2: тёмная тема — вторая очередь, но палитра сразу переменными.
// Переменные готовы, поэтому тема просто работает.

export function ThemeToggle({ className }: { className?: string }) {
  const [dark, setDark] = useState(false);
  const [mounted, setMounted] = useState(false);

  // Тему ставит inline-скрипт в <head> до гидрации; читаем её из DOM после
  // монтирования (на сервере document недоступен).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- читаем актуальную тему из DOM после монтирования
    setDark(document.documentElement.classList.contains("dark"));
    setMounted(true);
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("aurora.theme", next ? "dark" : "light");
    } catch {
      /* noop */
    }
  };

  return (
    <button
      onClick={toggle}
      aria-label={dark ? "Включить светлую тему" : "Включить тёмную тему"}
      className={cn(
        "inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-xs",
        "text-text-2 transition-colors duration-200 hover:bg-surface-inset hover:text-text",
        className,
      )}
    >
      {/* До монтирования не знаем тему — рисуем нейтрально, без мигания */}
      {mounted && dark ? (
        <Sun className="h-[18px] w-[18px]" aria-hidden />
      ) : (
        <Moon className="h-[18px] w-[18px]" aria-hidden />
      )}
    </button>
  );
}
