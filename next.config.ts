import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// Явно фиксируем корень проекта — рядом лежит второй lockfile, и Turbopack иначе
// выбирает не ту директорию (предупреждение при сборке).
const root = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  turbopack: {
    root,
  },

  // Защитные HTTP-заголовки на все маршруты. Раньше их не было вовсе.
  // CSP намеренно НЕ ставим: приложение живёт на инлайн-стилях/скриптах (Next, Motion),
  // и жёсткий CSP без nonce-механики просто сломает рендер. Это отдельная аккуратная задача.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" }, // кликджекинг: нас нельзя встроить в iframe
          { key: "X-Content-Type-Options", value: "nosniff" }, // не угадывать MIME-тип
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "X-DNS-Prefetch-Control", value: "on" },
        ],
      },
    ];
  },
};

export default nextConfig;
