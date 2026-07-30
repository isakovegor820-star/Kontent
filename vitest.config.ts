import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Тестируем только чистую логику: TS-помощники из src/lib и чистое ядро воркера
// (worker/lib.mjs). Файлы с сайд-эффектами (worker.mjs, API-роуты, DB) не трогаем —
// они требуют живые Redis/Postgres и сюда не включаются.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,mjs}", "worker/**/*.test.mjs"],
  },
});
