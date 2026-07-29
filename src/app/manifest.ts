import type { MetadataRoute } from "next";

// PWA — требование ТЗ 4 («сайт + мобильная версия (PWA)»).
// Полноценный офлайн (service worker) — этап «Лоск»; манифест ставим сразу.

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Аврора — канал ведётся сам",
    short_name: "Аврора",
    description:
      "Разведка конкурентов, залетающие темы, ИИ-контент в твоём стиле и автопостинг в Telegram и VK.",
    start_url: "/app/calendar",
    display: "standalone",
    // Кремовая бумага необрутализма v3 — с 2026-07-28 основной мир продукта
    background_color: "#f4f0ea",
    theme_color: "#f4f0ea",
    lang: "ru",
    orientation: "portrait-primary",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
    ],
  };
}
