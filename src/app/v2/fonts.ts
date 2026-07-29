// Шрифты прототипа v2 — грузятся только на /v2, боевой лендинг за них не платит.
// Пара: дисплейная антиква (Playfair, кириллица, roman+italic) + моно (Plex).
import { Playfair_Display, IBM_Plex_Mono } from "next/font/google";

export const v2Display = Playfair_Display({
  subsets: ["latin", "cyrillic"],
  style: ["normal", "italic"],
  variable: "--v2-display",
});

export const v2Mono = IBM_Plex_Mono({
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600"],
  variable: "--v2-mono",
});
