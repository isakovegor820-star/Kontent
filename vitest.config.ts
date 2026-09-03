import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Тестируем чистую логику (src/lib, worker/lib.mjs, pure E2E config) и React-компоненты
// админ-панели в jsdom с подменённым fetch (`// @vitest-environment jsdom` в файле теста).
// Файлы с сайд-эффектами (worker.mjs, DB) требуют живые Redis/Postgres и сюда не включаются.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: [
      "src/**/*.test.{ts,tsx,mjs}",
      "worker/**/*.test.mjs",
      "scripts/build-*.test.mjs",
      "scripts/e2e-*.test.mjs",
    ],
  },
});
