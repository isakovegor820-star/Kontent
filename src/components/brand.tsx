"use client";

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
