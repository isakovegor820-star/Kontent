import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import IORedis from "ioredis";
import { Pool } from "pg";
import { migrate, recordBootstrapMigrations } from "./migrate.mjs";
import { assertRuntimeSchemaReady } from "./runtime-schema-preflight.mjs";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379";
const DEFAULT_TIMEOUT_MS = 30_000;
const RETRY_INTERVAL_MS = 500;

export class DevelopmentDependencyError extends Error {
  constructor(label, timeoutMs, options = {}) {
    super(`${label} не стал доступен за ${Math.ceil(timeoutMs / 1_000)} сек.`, options);
    this.name = "DevelopmentDependencyError";
    this.code = "development_dependency_unavailable";
  }
}

function connectionUrl(value) {
  try {
    return new URL(String(value || "").trim());
  } catch {
    return null;
  }
}

export function isLoopbackConnection(value) {
  const url = connectionUrl(value);
  return Boolean(url && LOOPBACK_HOSTS.has(url.hostname));
}

function numericFormulaVersion(formula) {
  const match = formula.match(/@([0-9]+)$/u);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export function pickPostgresFormula(formulas) {
  return [...formulas]
    .filter((formula) => /^postgresql(?:@[0-9]+)?$/u.test(formula))
    .sort((left, right) => numericFormulaVersion(right) - numericFormulaVersion(left))[0] || null;
}

function timeoutFrom(env) {
  const configured = Number(env.AURORA_DEV_STARTUP_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 1_000 ? configured : DEFAULT_TIMEOUT_MS;
}

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

export async function waitForDependency(label, probe, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? RETRY_INTERVAL_MS;
  const now = options.now || Date.now;
  const sleep = options.sleep || delay;
  const startedAt = now();
  let lastError;

  while (now() - startedAt < timeoutMs) {
    try {
      await probe();
      return;
    } catch (error) {
      lastError = error;
      await sleep(intervalMs);
    }
  }

  throw new DevelopmentDependencyError(label, timeoutMs, { cause: lastError });
}

function postgresPoolOptions(connectionString, env) {
  return {
    connectionString,
    ssl: isLoopbackConnection(connectionString)
      ? false
      : { rejectUnauthorized: env.PGSSL_REJECT_UNAUTHORIZED !== "false" },
    max: 1,
    connectionTimeoutMillis: 1_500,
    statement_timeout: 5_000,
  };
}

async function withPostgresClient(connectionString, env, callback) {
  const pool = new Pool(postgresPoolOptions(connectionString, env));
  let client;
  try {
    client = await pool.connect();
    return await callback(client);
  } finally {
    client?.release();
    await pool.end();
  }
}

async function probeDatabase(connectionString, env) {
  await withPostgresClient(connectionString, env, (client) => client.query("select 1"));
}

async function probeRedis(redisUrl) {
  const client = new IORedis(redisUrl, {
    lazyConnect: true,
    connectTimeout: 1_500,
    commandTimeout: 2_000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  client.on("error", () => {});
  try {
    await client.connect();
    await client.ping();
  } finally {
    client.disconnect(false);
  }
}

let brewFormulas;

function installedBrewFormulas() {
  if (brewFormulas) return brewFormulas;
  const result = spawnSync("brew", ["list", "--formula"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  brewFormulas = result.status === 0
    ? result.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)
    : [];
  return brewFormulas;
}

function startBrewService(formula, logger) {
  if (!formula) return false;
  logger.log(`[dev] запускаю ${formula}…`);
  const result = spawnSync("brew", ["services", "start", formula], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}

function postgresAdminUrl(connectionString) {
  const url = connectionUrl(connectionString);
  if (!url) throw new Error("DATABASE_URL задан некорректно");
  url.pathname = "/postgres";
  url.searchParams.delete("schema");
  return url.toString();
}

function databaseName(connectionString) {
  const url = connectionUrl(connectionString);
  const name = url ? decodeURIComponent(url.pathname.replace(/^\/+|\/+$/gu, "")) : "";
  if (!name) throw new Error("В DATABASE_URL не указано имя базы");
  return name;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function ensureLocalDatabaseExists(connectionString, env, logger) {
  const adminUrl = postgresAdminUrl(connectionString);
  const name = databaseName(connectionString);
  await withPostgresClient(adminUrl, env, async (client) => {
    const exists = await client.query("select 1 from pg_database where datname = $1", [name]);
    if (exists.rowCount) return;
    logger.log(`[dev] создаю локальную базу ${name}…`);
    await client.query(`create database ${quoteIdentifier(name)}`);
  });
}

async function ensureDatabase(connectionString, env, logger, timeoutMs) {
  try {
    await probeDatabase(connectionString, env);
    return;
  } catch {
    // The normal path stays silent. Recovery is only attempted after a real failed probe.
  }

  if (isLoopbackConnection(connectionString)) {
    const formula = pickPostgresFormula(installedBrewFormulas());
    startBrewService(formula, logger);
    logger.log("[dev] жду PostgreSQL…");
    const adminUrl = postgresAdminUrl(connectionString);
    await waitForDependency("PostgreSQL", () => probeDatabase(adminUrl, env), { timeoutMs });
    await ensureLocalDatabaseExists(connectionString, env, logger);
  } else {
    logger.log("[dev] жду PostgreSQL…");
  }

  await waitForDependency("PostgreSQL", () => probeDatabase(connectionString, env), { timeoutMs });
}

async function ensureRedis(redisUrl, logger, timeoutMs) {
  try {
    await probeRedis(redisUrl);
    return;
  } catch {
    // See ensureDatabase: only local failed dependencies are started automatically.
  }

  if (isLoopbackConnection(redisUrl)) {
    const formulas = installedBrewFormulas();
    startBrewService(formulas.includes("redis") ? "redis" : null, logger);
  }
  logger.log("[dev] жду Redis…");
  await waitForDependency("Redis", () => probeRedis(redisUrl), { timeoutMs });
}

async function bootstrapEmptyLocalDatabase(connectionString, env, logger) {
  await withPostgresClient(connectionString, env, async (client) => {
    const result = await client.query(
      "select count(*)::integer as count from pg_tables where schemaname = 'public'",
    );
    if (Number(result.rows[0]?.count || 0) !== 0) return;

    logger.log("[dev] создаю локальную схему базы…");
    const schema = await readFile(resolve(process.cwd(), "db/schema.sql"), "utf8");
    await client.query("begin");
    try {
      await client.query(schema);
      await recordBootstrapMigrations(client);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

export async function prepareDevelopmentRuntime(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const connectionString = String(env.DATABASE_URL || "").trim();
  const redisUrl = String(env.REDIS_URL || DEFAULT_REDIS_URL).trim();
  const timeoutMs = timeoutFrom(env);

  if (!connectionString) throw new Error("DATABASE_URL не задан в .env.local");

  await Promise.all([
    ensureDatabase(connectionString, env, logger, timeoutMs),
    ensureRedis(redisUrl, logger, timeoutMs),
  ]);

  if (isLoopbackConnection(connectionString)) {
    await bootstrapEmptyLocalDatabase(connectionString, env, logger);
    await migrate({ env, logger });
  }

  await assertRuntimeSchemaReady({ env });
  logger.log("[dev] PostgreSQL, Redis и схема готовы");
}

export function safeDevelopmentFailure(error) {
  return {
    code: error?.code || "development_runtime_unavailable",
    reason: error instanceof Error ? error.message : "Не удалось подготовить dev-окружение",
  };
}
