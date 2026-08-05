import Redis from "ioredis";
import { getPool } from "./db";
import {
  isFreshPublicationHeartbeat,
  PUBLICATION_WORKER_HEARTBEAT_KEY,
  type DependencyState,
  type SchemaReadinessState,
} from "./readiness";
import { SCHEMA_MANIFEST } from "./schema-manifest.mjs";
import { probeSchemaCompatibility } from "./schema-readiness.mjs";

function schemaNotChecked(reason: string): SchemaReadinessState {
  return {
    ready: false,
    expectedVersion: SCHEMA_MANIFEST.schemaVersion,
    actualVersion: null,
    appliedMigrations: 0,
    expectedMigrations: SCHEMA_MANIFEST.migrations.length,
    reasons: [reason],
  };
}

export async function probeDatabaseAndSchema(): Promise<{
  database: DependencyState;
  schema: SchemaReadinessState;
}> {
  if (!process.env.DATABASE_URL) {
    return {
      database: "not_configured",
      schema: schemaNotChecked("schema_not_checked:database_not_configured"),
    };
  }
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const schema = await Promise.race([
      probeSchemaCompatibility(getPool()),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("database_probe_timeout")), 2_000);
      }),
    ]);
    return { database: "up", schema };
  } catch {
    return {
      database: "down",
      schema: schemaNotChecked("schema_not_checked:database_unreachable"),
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function probeDatabase(): Promise<DependencyState> {
  return (await probeDatabaseAndSchema()).database;
}

/** Configuration evidence only; provider health still has to prove an observed success. */
export function probeAiConfiguration(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    String(env.NAVYAI_API_KEY || "").trim()
      || String(env.OPENAI_API_KEY || env.AI_API_KEY || "").trim()
      || String(env.ANTHROPIC_API_KEY || "").trim()
      || String(env.GEMINI_API_KEY || "").trim()
      || String(env.AI_SERVICE_ENGINE || "").trim() === "local",
  );
}

/** Mail is a separate degraded capability; no secret value is returned or logged. */
export function probeMailDeliveryConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): DependencyState {
  const apiKey = String(env.RESEND_API_KEY || env.EMAIL_API_KEY || "").trim();
  const from = String(env.PASSWORD_RESET_FROM || env.EMAIL_FROM || "").trim();
  const appUrl = String(env.APP_URL || "").trim();
  const envelopeKey = String(env.TOKENS_MASTER_KEY || "").trim();
  if (!apiKey || !from || !appUrl || !envelopeKey) return "not_configured";
  try {
    const parsed = new URL(appUrl);
    if (!/^https?:$/u.test(parsed.protocol)) return "not_configured";
    if (env.NODE_ENV === "production" && parsed.protocol !== "https:") return "not_configured";
    return "up";
  } catch {
    return "not_configured";
  }
}

export async function probeRedisAndPublicationWorker(): Promise<{
  redis: DependencyState;
  publicationWorker: DependencyState;
}> {
  const url = String(process.env.REDIS_URL || "").trim();
  if (!url) return { redis: "not_configured", publicationWorker: "not_configured" };

  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 1_500,
    commandTimeout: 1_500,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
  });
  client.on("error", () => {});
  try {
    await client.connect();
    await client.ping();
    const heartbeat = await client.get(PUBLICATION_WORKER_HEARTBEAT_KEY);
    return {
      redis: "up",
      publicationWorker: isFreshPublicationHeartbeat(heartbeat) ? "up" : "down",
    };
  } catch {
    return { redis: "down", publicationWorker: "down" };
  } finally {
    client.disconnect(false);
  }
}
