import type { MetadataRoute } from "next";

// PWA — требование ТЗ 4 («сайт + мобильная версия (PWA)»).
// Полноценный офлайн (service worker) — этап «Лоск»; манифест ставим сразу.

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Аврора — соцсети, которые ведут себя сами",
    short_name: "Аврора",
    description:
      "Разведка конкурентов, залетающие темы, ИИ-контент в твоём стиле и автопостинг в Telegram и VK.",
    start_url: "/app/calendar",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#6366f1",
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
