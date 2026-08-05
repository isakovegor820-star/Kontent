import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import IORedis from "ioredis";
import { Queue } from "bullmq";
import { migrate } from "./migrate.mjs";
import { SCHEMA_MANIFEST } from "../src/lib/schema-manifest.mjs";
import { probeSchemaCompatibility } from "../src/lib/schema-readiness.mjs";
import { PUBLICATION_HEARTBEAT_KEY } from "../worker/publication-heartbeat.mjs";

const databaseUrl = String(process.env.MIGRATION_TEST_DATABASE_URL || "").trim();
const redisUrl = String(process.env.MIGRATION_TEST_REDIS_URL || "").trim();

function assertDisposableTargets() {
  if (!databaseUrl || !redisUrl) {
    throw new Error("MIGRATION_TEST_DATABASE_URL and MIGRATION_TEST_REDIS_URL are required");
  }
  const database = new URL(databaseUrl);
  const redis = new URL(redisUrl);
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  const databaseName = database.pathname.replace(/^\//u, "");
  if (!localHosts.has(database.hostname) || databaseName !== "aurora_schema_gate_test") {
    throw new Error("schema readiness integration requires the disposable aurora_schema_gate_test database");
  }
  if (!localHosts.has(redis.hostname) || Number(redis.port || 6379) === 6379) {
    throw new Error("schema readiness integration requires a non-default disposable local Redis port");
  }
}

async function resetLegacy(pool, schemaSql) {
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query(schemaSql);
}

function waitForExit(child, timeoutMs = 10_000) {
  return new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("worker preflight did not terminate"));
    }, timeoutMs);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
  });
}

assertDisposableTargets();
const schemaSql = await readFile(resolve(process.cwd(), "db/fixtures/legacy-migration.sql"), "utf8");
const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 2 });
const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const queue = new Queue("publish", { connection: redis });
const qaJobId = `qa-schema-gate-${process.pid}`;

try {
  await resetLegacy(pool, schemaSql);
  const legacy = await probeSchemaCompatibility(pool);
  assert.equal(legacy.ready, false);
  assert(legacy.reasons.includes("schema_migrations_table_missing"));

  await queue.add("publish", { postId: 9_999_999 }, { jobId: qaJobId });
  const worker = spawn(process.execPath, ["worker.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      AURORA_WORKER_MODE: "full",
      TG_BOT_TOKEN: "",
      TG_CHAT_ID: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Drain child output without printing environment-dependent details.
  worker.stdout.resume();
  worker.stderr.resume();
  const stopped = await waitForExit(worker);
  assert.notEqual(stopped.code, 0, "worker must fail before creating consumers");
  assert.equal(await queue.getWaitingCount(), 1, "legacy-schema worker consumed a publish job");
  assert.equal(await redis.get(PUBLICATION_HEARTBEAT_KEY), null, "legacy-schema worker wrote a heartbeat");

  const firstMigration = SCHEMA_MANIFEST.migrations[0];
  const firstSql = await readFile(resolve(process.cwd(), "db/migrations", firstMigration.name), "utf8");
  await migrate({
    env: { ...process.env, DATABASE_URL: databaseUrl },
    migrations: [{ name: firstMigration.name, sql: firstSql }],
    logger: { log() {} },
  });
  const partial = await probeSchemaCompatibility(pool);
  assert.equal(partial.ready, false);
  assert(partial.reasons.includes(`migration_missing:${SCHEMA_MANIFEST.migrations[1].name}`));

  await pool.query("update schema_migrations set checksum = $2 where name = $1", [
    firstMigration.name,
    "0".repeat(64),
  ]);
  const wrongChecksum = await probeSchemaCompatibility(pool);
  assert.equal(wrongChecksum.ready, false);
  assert(wrongChecksum.reasons.includes(`migration_checksum_mismatch:${firstMigration.name}`));

  await resetLegacy(pool, schemaSql);
  await migrate({ env: { ...process.env, DATABASE_URL: databaseUrl }, logger: { log() {} } });
  const complete = await probeSchemaCompatibility(pool);
  assert.equal(complete.ready, true, complete.reasons.join(", "));
  assert.equal(complete.appliedMigrations, SCHEMA_MANIFEST.migrations.length);

  console.log(
    `Schema readiness integration passed: legacy/partial/checksum/full plus zero worker side effects (${SCHEMA_MANIFEST.migrations.length} migrations).`,
  );
} finally {
  await queue.remove(qaJobId).catch(() => {});
  await queue.close().catch(() => {});
  redis.disconnect(false);
  await pool.end().catch(() => {});
}
