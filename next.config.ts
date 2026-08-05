import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// Явно фиксируем корень проекта — рядом лежит второй lockfile, и Turbopack иначе
// выбирает не ту директорию (предупреждение при сборке).
const root = dirname(fileURLToPath(import.meta.url));
const requestedDistDir = String(process.env.AURORA_NEXT_DIST_DIR ?? "").trim();
const isolatedDistDir = /^\.next-[a-z0-9_-]+$/u.test(requestedDistDir)
  ? requestedDistDir
  : undefined;

const nextConfig: NextConfig = {
  // Browser E2E runs the same full `npm run dev` runtime alongside a developer's server.
  // A separate dist directory prevents both Next instances from sharing a dev lock/cache.
  ...(isolatedDistDir ? { distDir: isolatedDistDir } : {}),

  // `npm run dev` binds Next to localhost, while local browser/E2E tooling may use
  // 127.0.0.1. Next 16 blocks the dev chunks for that otherwise same-machine origin,
  // leaving Client Components unhydrated unless it is explicitly allowed.
  allowedDevOrigins: ["127.0.0.1", "localhost"],

  turbopack: {
    root,
  },

  // BullMQ and ioredis are Node-only runtime dependencies used by Route Handlers. Keep
  // their CommonJS/native dependency graphs out of the server bundle.
  serverExternalPackages: ["bullmq", "ioredis", "pdfkit"],

  // PDF exports resolve this Unicode font from disk at request time. Keep it in traced
  // server artifacts without asking Turbopack to compile a TTF as JavaScript.
  outputFileTracingIncludes: {
    "/api/library/exports/*": ["./node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf"],
  },

  async redirects() {
    const routes = [
      { source: "/app/radar", destination: "/app/recon", permanent: true },
    ];
    if (process.env.NODE_ENV === "production") {
      routes.push(
        { source: "/v2/:path*", destination: "/", permanent: false },
        { source: "/v3/:path*", destination: "/", permanent: false },
        { source: "/variants/:path*", destination: "/", permanent: false },
        { source: "/old", destination: "/", permanent: false },
        { source: "/scroll-test", destination: "/", permanent: false },
        { source: "/finale/:path*", destination: "/", permanent: false },
        { source: "/footer/:path*", destination: "/", permanent: false },
        { source: "/reasons/:path*", destination: "/", permanent: false },
      );
    }
    return routes;
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
