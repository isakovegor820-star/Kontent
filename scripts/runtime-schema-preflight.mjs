import pg from "pg";
import { probeSchemaCompatibility } from "../src/lib/schema-readiness.mjs";

export class RuntimeSchemaPreflightError extends Error {
  constructor(code, reasons = []) {
    super(code);
    this.name = "RuntimeSchemaPreflightError";
    this.code = code;
    this.reasons = [...reasons];
  }
}

function poolOptions(connectionString, env) {
  const local = /\/\/(?:[^@/]+@)?(?:localhost|127\.0\.0\.1)(?::|\/)/u.test(connectionString);
  return {
    connectionString,
    ssl: local ? false : { rejectUnauthorized: env.PGSSL_REJECT_UNAUTHORIZED !== "false" },
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
  if (error instanceof RuntimeSchemaPreflightError) {
    return { code: error.code, reasons: error.reasons };
  }
  return { code: "preflight_failed", reasons: [] };
}

