"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";

/* ---------------------------------------------------------------- ЛОГОТИП */
// «А» — Аврора. Скрытый луч внутри буквы направлен вверх: идея превращается
// в готовую публикацию. Четырёхлучевая звезда отмечает работу ИИ.

export function Logo({
  className,
  size = 32,
  decorative = false,
}: {
  className?: string;
  size?: number;
  decorative?: boolean;
}) {
  const gradientId = `aurora-logo-${useId().replaceAll(":", "")}`;

  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={cn("shrink-0", className)}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : "Аврора"}
      aria-hidden={decorative || undefined}
      focusable="false"
    >
      <defs>
        <linearGradient
          id={gradientId}
          x1="4"
          y1="3"
          x2="28"
          y2="30"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#3B82FF" />
          <stop offset="0.52" stopColor="#2563FF" />
          <stop offset="1" stopColor="#1746E8" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${gradientId})`} />
      {/* Плотная буква А */}
      <path
        d="M7.9 23.7 13.7 9.4A2.45 2.45 0 0 1 16 7.85a2.45 2.45 0 0 1 2.3 1.55l5.8 14.3h-4.45l-1.02-2.75h-5.26l-1.02 2.75H7.9Z"
        fill="white"
      />
      {/* Негативное пространство буквы складывается в луч-стрелку вверх */}
      <path
        d="m16 12.25 3.05 5.65h-1.68v2.08h-2.74V17.9h-1.68L16 12.25Z"
        fill={`url(#${gradientId})`}
      />
      {/* Четырёхлучевая звезда */}
      <path
        d="M24.65 4.7c.28 1.95 1.35 3.02 3.3 3.3-1.95.28-3.02 1.35-3.3 3.3-.28-1.95-1.35-3.02-3.3-3.3 1.95-.28 3.02-1.35 3.3-3.3Z"
        fill="white"
      />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <Logo decorative />
      <span className="text-[19px] font-extrabold tracking-tight text-text">Аврора</span>
    </span>
  );
}
