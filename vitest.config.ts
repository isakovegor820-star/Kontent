import { defineConfig } from "vitest/config";

// Тестируем только чистую логику: TS-помощники из src/lib и чистое ядро воркера
// (worker/lib.mjs). Файлы с сайд-эффектами (worker.mjs, API-роуты, DB) не трогаем —
// они требуют живые Redis/Postgres и сюда не включаются.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,mjs}", "worker/**/*.test.mjs"],
  },
});
