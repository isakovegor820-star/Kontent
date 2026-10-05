import pg from "pg";
import { probeSchemaCompatibility } from "../src/lib/schema-readiness.mjs";
import { resolvePgSslRejectUnauthorized } from "../src/lib/db-pool-config.mjs";
import { assertTrustedProxyBootContract } from "../src/lib/trusted-proxy-contract.mjs";

export class RuntimeSchemaPreflightError extends Error {
  constructor(code, reasons = []) {
    super(code);
    this.name = "RuntimeSchemaPreflightError";
    this.code = code;
    this.reasons = [...reasons];
  }
}

export class RuntimeBootContractError extends Error {
  constructor(code) {
    super(code);
    this.name = "RuntimeBootContractError";
    this.code = code;
    this.reasons = [`boot_contract:${code}`];
  }
}

/**
 * Boot-контракты production-рантайма, проверяемые ДО `next start`.
 *
 * Инцидент 2026-10-05: сервис ru.aurora.web запускал `next start` мимо этого префлайта
 * и без `AURORA_TRUSTED_PROXY_HOPS`. Процесс поднимал сокет, отвечал 500 на каждый
 * запрос и оставался живым сутки. Теперь точки входа отказываются стартовать.
 *
 * `NODE_ENV` форсируется в production осознанно: `next start` выставляет его сам, а
 * ambient-значение в момент префлайта может быть не задано — иначе проверка молча
 * пропускалась бы ровно там, где нужна. Dev-путь (scripts/dev-bootstrap.mjs) эту
 * функцию не вызывает и по-прежнему работает без переменной.
 */
export function assertRuntimeBootContracts(options = {}) {
  const env = { ...(options.env || process.env), NODE_ENV: "production" };
  try {
    assertTrustedProxyBootContract(env);
  } catch (error) {
    const code = error instanceof Error && error.message ? error.message : "boot_contract_failed";
    throw new RuntimeBootContractError(code);
  }
}

function poolOptions(connectionString, env) {
  const local = /\/\/(?:[^@/]+@)?(?:localhost|127\.0\.0\.1)(?::|\/)/u.test(connectionString);
  return {
    connectionString,
    ssl: local ? false : { rejectUnauthorized: resolvePgSslRejectUnauthorized(env) },
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
  };
}

/**
 * Read-only release gate. It deliberately does not call the migration runner: applying
 * schema changes is a separate, explicitly-authorized deployment step.
 */
export async function assertRuntimeSchemaReady(options = {}) {
  const env = options.env || process.env;
  const externalClient = options.client || null;
  let ownedPool = null;
  let client = externalClient;
  let connectedClient = null;
  try {
    if (!client) {
      const connectionString = String(env.DATABASE_URL || "").trim();
      if (!connectionString) {
        throw new RuntimeSchemaPreflightError("database_not_configured", [
          "schema_not_checked:database_not_configured",
        ]);
      }
      const Pool = options.Pool || pg.Pool;
      ownedPool = new Pool(poolOptions(connectionString, env));
      connectedClient = await ownedPool.connect();
      client = connectedClient;
    }

    const report = await probeSchemaCompatibility(client);
    if (!report.ready) {
      throw new RuntimeSchemaPreflightError("schema_incompatible", report.reasons);
    }
    return report;
  } catch (error) {
    if (error instanceof RuntimeSchemaPreflightError) throw error;
    throw new RuntimeSchemaPreflightError("database_unreachable", [
      "schema_not_checked:database_unreachable",
    ]);
  } finally {
    connectedClient?.release();
    await ownedPool?.end();
  }
}

export function safePreflightFailure(error) {
  if (error instanceof RuntimeSchemaPreflightError || error instanceof RuntimeBootContractError) {
    return { code: error.code, reasons: error.reasons };
  }
  return { code: "preflight_failed", reasons: [] };
}

