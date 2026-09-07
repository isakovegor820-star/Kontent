import Redis from "ioredis";
import { randomUUID } from "node:crypto";
import { resolveEngineRuntime, serviceEngine } from "./ai-provider";
import { completeAiText } from "./ai-completion-service.mjs";
import {
  aiProviderCircuitBreaker,
  aiProviderHealthSnapshot,
  type ProviderHealthSnapshot,
} from "./ai-provider-health";
import { getPool } from "./db";
import type { EngineId } from "./engines";
import {
  isFreshPublicationHeartbeat,
  isFreshAiProviderEvidence,
  telegramPollingHeartbeatState,
  PUBLICATION_WORKER_HEARTBEAT_KEY,
  TELEGRAM_POLLING_WORKER_HEARTBEAT_KEY,
  type DependencyState,
  type SchemaReadinessState,
} from "./readiness";
import { SCHEMA_MANIFEST } from "./schema-manifest.mjs";
import { probeSchemaCompatibility } from "./schema-readiness.mjs";
import { avatarIngressConfigured } from "./upload-ingress.mjs";
import { tokenEnvelopeKeyReadiness } from "./token-reencryption.mjs";

function schemaNotChecked(reason: string): SchemaReadinessState {
  return {
    ready: false,
    expectedVersion: SCHEMA_MANIFEST.schemaVersion,
    actualVersion: null,
    appliedMigrations: 0,
    expectedMigrations: SCHEMA_MANIFEST.migrations.length,
    forwardMigrations: [],
    reasons: [reason],
  };
}

export async function probeDatabaseAndSchema(): Promise<{
  database: DependencyState;
  schema: SchemaReadinessState;
  tokenEncryption: DependencyState;
}> {
  if (!process.env.DATABASE_URL) {
    return {
      database: "not_configured",
      schema: schemaNotChecked("schema_not_checked:database_not_configured"),
      tokenEncryption: "not_configured",
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
    let tokenEncryption: DependencyState = "down";
    if (schema.ready) {
      tokenEncryption = (await tokenEnvelopeKeyReadiness(getPool())).state;
    }
    return { database: "up", schema, tokenEncryption };
  } catch {
    return {
      database: "down",
      schema: schemaNotChecked("schema_not_checked:database_unreachable"),
      tokenEncryption: "down",
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

interface AiProviderReadinessDependencies {
  configured: () => boolean;
  engine: () => EngineId;
  canProbe?: (engine: EngineId) => boolean;
  ready: (engine: EngineId) => Promise<boolean>;
  snapshot: () => ProviderHealthSnapshot[];
  recordSuccess: (engine: EngineId, latencyMs: number) => void;
  recordFailure: (
    engine: EngineId,
    input: { code: string; transient: boolean; latencyMs: number },
  ) => void;
  now: () => number;
}

const defaultAiProviderReadinessDependencies: AiProviderReadinessDependencies = {
  configured: probeAiConfiguration,
  engine: serviceEngine,
  canProbe: (engine) => resolveEngineRuntime(engine).configured && resolveEngineRuntime(engine).supported,
  // A model catalogue can return 200 while the selected completion route returns 410.
  // Only an actual terminal completion establishes execution evidence. The fixed prompt
  // contains no account content; one attempt, no fallback, bounded by five seconds.
  ready: async (engine) => {
    const result = await completeAiText({
      engine, system: "This is a synthetic availability check. Reply only READY.",
      user: "READY", temperature: 0, maxTokens: 8, providerRequestKey: randomUUID(),
    }, { allowFallback: false, maxAttempts: 1, timeoutMs: 4_000, overallTimeoutMs: 5_000 });
    return result.engine === engine && result.text.trim().length > 0;
  },
  snapshot: aiProviderHealthSnapshot,
  recordSuccess: (engine, latencyMs) => aiProviderCircuitBreaker.recordSuccess(engine, latencyMs),
  recordFailure: (engine, input) => aiProviderCircuitBreaker.recordFailure(engine, input),
  now: Date.now,
};

/**
 * A web restart clears the in-process circuit snapshot. On the first authorized
 * readiness check (and after expiry), establish bounded capability evidence.
 * Fresh runtime failures are preserved; expired results must permit recovery.
 */
const aiReadinessFlights = new Map<EngineId, Promise<ProviderHealthSnapshot[]>>();

export function probeAiProviderReadiness(
  dependencies: AiProviderReadinessDependencies = defaultAiProviderReadinessDependencies,
): Promise<ProviderHealthSnapshot[]> {
  if (dependencies !== defaultAiProviderReadinessDependencies) return runAiProviderReadiness(dependencies);
  const engine = dependencies.engine();
  const existing = aiReadinessFlights.get(engine);
  if (existing) return existing;
  const flight = runAiProviderReadiness(dependencies).finally(() => aiReadinessFlights.delete(engine));
  aiReadinessFlights.set(engine, flight);
  return flight;
}

async function runAiProviderReadiness(dependencies: AiProviderReadinessDependencies): Promise<ProviderHealthSnapshot[]> {
  const existing = dependencies.snapshot();
  if (!dependencies.configured()) return existing;
  const engine = dependencies.engine();
  const startedAt = dependencies.now();
  const relevant = existing.filter(provider => provider.engine === engine);
  const current = relevant[0];
  if (current && isFreshAiProviderEvidence(current, startedAt)) return relevant;
  if (dependencies.canProbe && !dependencies.canProbe(engine)) return relevant;
  let providerReady = false;
  try {
    providerReady = await dependencies.ready(engine);
  } catch {
    providerReady = false;
  }
  const latencyMs = Math.max(0, dependencies.now() - startedAt);
  if (providerReady) {
    dependencies.recordSuccess(engine, latencyMs);
  } else {
    dependencies.recordFailure(engine, {
      code: "readiness_probe_failed",
      transient: true,
      latencyMs,
    });
  }
  return dependencies.snapshot().filter(provider => provider.engine === engine);
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

export function probeUploadIngressConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): DependencyState {
  return avatarIngressConfigured(env) ? "up" : "not_configured";
}

export function probeTrackingSecretsConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): DependencyState {
  const attribution = String(env.TRACKING_ATTRIBUTION_SECRET || "").trim();
  const fingerprint = String(env.TRACKING_FINGERPRINT_SECRET || "").trim();
  if (!attribution && !fingerprint) return "not_configured";
  if (attribution.length < 32 || fingerprint.length < 32 || attribution === fingerprint) return "down";
  return "up";
}

export async function probeRedisAndPublicationWorker(): Promise<{
  redis: DependencyState;
  publicationWorker: DependencyState;
  telegramPolling: DependencyState;
}> {
  const url = String(process.env.REDIS_URL || "").trim();
  const telegramConfigured = Boolean(String(process.env.TG_BOT_TOKEN || "").trim());
  if (!url) {
    return {
      redis: "not_configured",
      publicationWorker: "not_configured",
      telegramPolling: telegramConfigured ? "down" : "not_configured",
    };
  }

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
    const [publicationHeartbeat, telegramPollingHeartbeat] = await client.mget(
      PUBLICATION_WORKER_HEARTBEAT_KEY,
      TELEGRAM_POLLING_WORKER_HEARTBEAT_KEY,
    );
    return {
      redis: "up",
      publicationWorker: isFreshPublicationHeartbeat(publicationHeartbeat) ? "up" : "down",
      telegramPolling: !telegramConfigured
        ? "not_configured"
        : telegramPollingHeartbeatState(telegramPollingHeartbeat) ?? "down",
    };
  } catch {
    return {
      redis: "down",
      publicationWorker: "down",
      telegramPolling: telegramConfigured ? "down" : "not_configured",
    };
  } finally {
    client.disconnect(false);
  }
}
