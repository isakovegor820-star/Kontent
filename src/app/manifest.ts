import type { MetadataRoute } from "next";

import { PRODUCT_DESCRIPTION, PRODUCT_NAME } from "@/lib/product";

// PWA — требование ТЗ 4 («сайт + мобильная версия (PWA)»).
// Полноценный офлайн (service worker) — этап «Лоск»; манифест ставим сразу.
// Имя и описание берутся из lib/product: манифест читают и люди, и движки,
// и он не должен рассказывать другую историю, чем title и og.

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${PRODUCT_NAME} — юридический контент`,
    short_name: PRODUCT_NAME,
    description: PRODUCT_DESCRIPTION,
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
