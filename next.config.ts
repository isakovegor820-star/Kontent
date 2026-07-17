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
};

export default nextConfig;
