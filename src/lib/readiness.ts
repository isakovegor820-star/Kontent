import type { ProviderHealthSnapshot } from "./ai-provider-health";
import {
  parsePublicationHeartbeat,
  PUBLICATION_HEARTBEAT_KEY,
  PUBLICATION_HEARTBEAT_TTL_SECONDS,
} from "../../worker/publication-heartbeat.mjs";
import {
  parseTelegramPollingHeartbeat,
  TELEGRAM_POLLING_HEARTBEAT_KEY,
  TELEGRAM_POLLING_HEARTBEAT_TTL_SECONDS,
} from "../../worker/telegram-polling-heartbeat.mjs";

export const PUBLICATION_WORKER_HEARTBEAT_KEY = PUBLICATION_HEARTBEAT_KEY;
export const PUBLICATION_WORKER_HEARTBEAT_MAX_AGE_MS = PUBLICATION_HEARTBEAT_TTL_SECONDS * 1_000;
export const TELEGRAM_POLLING_WORKER_HEARTBEAT_KEY = TELEGRAM_POLLING_HEARTBEAT_KEY;
export const TELEGRAM_POLLING_WORKER_HEARTBEAT_MAX_AGE_MS = TELEGRAM_POLLING_HEARTBEAT_TTL_SECONDS * 1_000;

export type DependencyState = "up" | "down" | "not_configured" | "conflict";

export interface SchemaReadinessState {
  ready: boolean;
  expectedVersion: string;
  actualVersion: string | null;
  appliedMigrations: number;
  expectedMigrations: number;
  reasons: string[];
}

export interface ReadinessInput {
  database: DependencyState;
  schema: SchemaReadinessState;
  redis: DependencyState;
  publicationWorker: DependencyState;
  telegramPolling: DependencyState;
  aiProviders: ProviderHealthSnapshot[];
  aiConfigured: boolean;
  mailDelivery: DependencyState;
  uploadIngress: DependencyState;
  tokenEncryption: DependencyState;
  trackingSecrets: DependencyState;
  checkedAt?: Date;
}

export interface ReadinessReport {
  status: "ready" | "degraded" | "not_ready";
  processAlive: true;
  databaseReady: boolean;
  schemaReady: boolean;
  webReady: boolean;
  publicationReady: boolean;
  telegramBotReady: boolean;
  aiReady: boolean;
  mailDeliveryReady: boolean;
  uploadReady: boolean;
  tokenEncryptionReady: boolean;
  trackingReady: boolean;
  passwordRecoveryReady: boolean;
  reasons: string[];
  checkedAt: string;
  checks: {
    database: DependencyState;
    schema: SchemaReadinessState;
    redis: DependencyState;
    publicationWorker: DependencyState;
    telegramPolling: DependencyState;
    aiProviders: ProviderHealthSnapshot[];
    aiConfigured: boolean;
    mailDelivery: DependencyState;
    uploadIngress: DependencyState;
    tokenEncryption: DependencyState;
    trackingSecrets: DependencyState;
  };
}

export type ServiceReadiness = Pick<
  ReadinessReport,
  "webReady" | "publicationReady" | "telegramBotReady" | "aiReady" | "schemaReady" | "mailDeliveryReady"
  | "uploadReady"
  | "tokenEncryptionReady"
  | "trackingReady"
>;

/** A failed readiness request must fail closed instead of claiming that the web tier is ready. */
export function readinessRequestFailure(): ServiceReadiness {
  return {
    webReady: false,
    publicationReady: false,
    telegramBotReady: false,
    aiReady: false,
    schemaReady: false,
    mailDeliveryReady: false,
    uploadReady: false,
    tokenEncryptionReady: false,
    trackingReady: false,
  };
}

export function evaluateReadiness(input: ReadinessInput): ReadinessReport {
  const databaseReady = input.database === "up";
  const schemaReady = databaseReady && input.schema.ready;
  const uploadReady = input.uploadIngress === "up";
  const webReady = databaseReady && schemaReady && uploadReady;
  const publicationReady = webReady
    && input.redis === "up"
    && input.publicationWorker === "up"
    && input.tokenEncryption === "up";
  const telegramBotReady = webReady
    && input.redis === "up"
    && input.telegramPolling === "up";
  // A configured but never-observed provider is not production evidence. The first
  // successful bounded provider call will populate the shared health snapshot.
  const aiReady = input.aiConfigured
    && input.aiProviders.length > 0
    && input.aiProviders.every(
      (provider) => provider.state !== "open" && provider.lastOutcome === "success",
    );
  const mailDeliveryReady = input.mailDelivery === "up";
  const tokenEncryptionReady = input.tokenEncryption === "up";
  const trackingReady = input.trackingSecrets === "up";
  const passwordRecoveryReady = webReady && mailDeliveryReady;
  const reasons = [
    input.database === "not_configured" ? "database_not_configured" : null,
    input.database === "down" ? "database_unreachable" : null,
    ...input.schema.reasons,
    input.redis === "not_configured" ? "redis_not_configured" : null,
    input.redis === "down" ? "redis_unreachable" : null,
    input.publicationWorker === "not_configured" ? "publication_worker_not_configured" : null,
    input.publicationWorker === "down" ? "publication_worker_unavailable" : null,
    input.telegramPolling === "not_configured" ? "telegram_bot_not_configured" : null,
    input.telegramPolling === "down" ? "telegram_polling_unavailable" : null,
    input.telegramPolling === "conflict" ? "telegram_polling_conflict" : null,
    !input.aiConfigured ? "ai_not_configured" : null,
    input.aiConfigured && input.aiProviders.length === 0 ? "ai_unobserved" : null,
    input.aiProviders.some((provider) => provider.state === "open") ? "ai_circuit_open" : null,
    input.aiProviders.length > 0
      && input.aiProviders.some((provider) => provider.lastOutcome !== "success")
      ? "ai_not_verified"
      : null,
    input.mailDelivery === "not_configured" ? "mail_delivery_not_configured" : null,
    input.mailDelivery === "down" ? "mail_delivery_unavailable" : null,
    input.uploadIngress === "not_configured" ? "avatar_ingress_limit_not_configured" : null,
    input.uploadIngress === "down" ? "avatar_ingress_limit_invalid" : null,
    schemaReady && input.tokenEncryption === "not_configured" ? "token_keyring_not_configured" : null,
    schemaReady && input.tokenEncryption === "down" ? "token_envelope_key_unknown" : null,
    input.trackingSecrets === "not_configured" ? "tracking_secrets_not_configured" : null,
    input.trackingSecrets === "down" ? "tracking_secrets_invalid" : null,
  ].filter((reason): reason is string => Boolean(reason));
  const degraded = !publicationReady || !telegramBotReady || !aiReady || !mailDeliveryReady || !trackingReady;

  return {
    status: !webReady ? "not_ready" : degraded ? "degraded" : "ready",
    processAlive: true,
    databaseReady,
    schemaReady,
    webReady,
    publicationReady,
    telegramBotReady,
    aiReady,
    mailDeliveryReady,
    uploadReady,
    tokenEncryptionReady,
    trackingReady,
    passwordRecoveryReady,
    reasons,
    checkedAt: (input.checkedAt ?? new Date()).toISOString(),
    checks: {
      database: input.database,
      schema: input.schema,
      redis: input.redis,
      publicationWorker: input.publicationWorker,
      telegramPolling: input.telegramPolling,
      aiProviders: input.aiProviders,
      aiConfigured: input.aiConfigured,
      mailDelivery: input.mailDelivery,
      uploadIngress: input.uploadIngress,
      tokenEncryption: input.tokenEncryption,
      trackingSecrets: input.trackingSecrets,
    },
  };
}

export function isFreshPublicationHeartbeat(raw: string | null, now = Date.now()): boolean {
  return Boolean(parsePublicationHeartbeat(raw, {
    nowMs: now,
    maxAgeMs: PUBLICATION_WORKER_HEARTBEAT_MAX_AGE_MS,
  }));
}

export function isFreshTelegramPollingHeartbeat(raw: string | null, now = Date.now()): boolean {
  return telegramPollingHeartbeatState(raw, now) === "up";
}

export function telegramPollingHeartbeatState(
  raw: string | null,
  now = Date.now(),
): "up" | "conflict" | null {
  return parseTelegramPollingHeartbeat(raw, {
    nowMs: now,
    maxAgeMs: TELEGRAM_POLLING_WORKER_HEARTBEAT_MAX_AGE_MS,
  })?.state ?? null;
}
