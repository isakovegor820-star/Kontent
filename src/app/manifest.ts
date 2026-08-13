import type { MetadataRoute } from "next";

// PWA — требование ТЗ 4 («сайт + мобильная версия (PWA)»).
// Полноценный офлайн (service worker) — этап «Лоск»; манифест ставим сразу.

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Аврора — SMM для юридического бизнеса",
    short_name: "Аврора",
    description:
      "Контент, согласование, календарь и публикация для юридических команд в одной платформе.",
    start_url: "/app/calendar",
    display: "standalone",
    background_color: "#f7faff",
    theme_color: "#2563ff",
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
