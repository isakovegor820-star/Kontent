import IORedis from "ioredis";
import pg from "pg";

import { safePreflightFailure } from "./runtime-schema-preflight.mjs";
import { assertSiteAnalysisSchemaReady } from "./site-analysis-schema-preflight.mjs";
import { createSiteAnalysisWorker } from "../worker/site-analysis-worker.mjs";

const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("[site-analysis] DATABASE_URL не задан");
  process.exit(1);
}

const isLocalDatabase = /\/\/(?:[^@/]+@)?(?:localhost|127\.0\.0\.1)(?::|\/)/u.test(databaseUrl);
const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: isLocalDatabase
    ? false
    : { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== "false" },
});
pool.on("error", (error) => {
  console.error("[site-analysis] соединение с PostgreSQL прервано", error?.message || error);
});

try {
  await assertSiteAnalysisSchemaReady(pool);
} catch (error) {
  console.error("[site-analysis] schema preflight failed", safePreflightFailure(error));
  await pool.end().catch(() => undefined);
  process.exit(1);
}

const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
connection.on("error", (error) => {
  console.error("[site-analysis] Redis недоступен", error?.message || error);
});

const worker = createSiteAnalysisWorker({ connection, pool, concurrency: 1 });
let stopping = false;

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[site-analysis] останавливаем worker (${signal})`);
  await worker.close().catch(() => undefined);
  await connection.quit().catch(() => connection.disconnect(false));
  await pool.end().catch(() => undefined);
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

console.log("[site-analysis] безопасный worker анализа сайтов запущен");
