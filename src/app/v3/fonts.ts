// Шрифты необрутализма v3 — с 2026-07-28 это главный лендинг (/), алиас /v3.
// Их же подключают /register и /app (app-v3). Пара: гротескный дисплей (Unbounded,
// кириллица) + моно (Plex) для пульта, промптов и служебных подписей.
// Текст — платформенный Golos из корневого layout.
import { Unbounded, IBM_Plex_Mono } from "next/font/google";

export const v3Display = Unbounded({
  subsets: ["latin", "cyrillic"],
  weight: ["500", "700", "900"],
  variable: "--v3-display",
});

export const v3Mono = IBM_Plex_Mono({
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600"],
  variable: "--v3-mono",
});
