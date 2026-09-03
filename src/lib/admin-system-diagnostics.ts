import { Queue } from "bullmq";
import Redis from "ioredis";
import type { Pool } from "pg";

import {
  parsePublicationHeartbeat,
  PUBLICATION_HEARTBEAT_INTERVAL_MS,
  PUBLICATION_HEARTBEAT_KEY,
  PUBLICATION_HEARTBEAT_TTL_SECONDS,
} from "../../worker/publication-heartbeat.mjs";
import {
  parseTelegramPollingHeartbeat,
  TELEGRAM_POLLING_HEARTBEAT_KEY,
  TELEGRAM_POLLING_HEARTBEAT_TTL_SECONDS,
} from "../../worker/telegram-polling-heartbeat.mjs";
import { aiProviderHealthSnapshot } from "./ai-provider-health";
import { getDatabasePoolSnapshot, getPool } from "./db";
import {
  probeAiConfiguration,
  probeDatabaseAndSchema,
  probeMailDeliveryConfiguration,
  probeTrackingSecretsConfiguration,
  probeUploadIngressConfiguration,
} from "./readiness-probes";
import { redisProducerConnectionOptions } from "./queue";
import { auroraReleaseMetadata } from "./release-metadata";

/**
 * `configured` is deliberately separate from `healthy`: a check that only inspects
 * configuration (env presence, URL scheme) proves nothing about runtime behaviour and
 * must not be counted as a confirmed working dependency.
 */
export const ADMIN_DIAGNOSTIC_STATES = [
  "healthy",
  "degraded",
  "down",
  "unobserved",
  "not_configured",
  "configured",
  "conflict",
] as const;

export type AdminDiagnosticState = typeof ADMIN_DIAGNOSTIC_STATES[number];
export type AdminDiagnosticGroup = "core" | "integrations" | "security";

export type AdminDiagnosticEvidence = Readonly<{
  label: string;
  value: string | number | boolean | null;
  tone?: "positive" | "neutral" | "warning" | "critical";
}>;

export type AdminQueueSnapshot = Readonly<{
  name: string;
  state: AdminDiagnosticState;
  workers: number | null;
  waiting: number | null;
  active: number | null;
  delayed: number | null;
  completed: number | null;
  failed: number | null;
  oldestJobAgeMs: number | null;
  safeErrorCode: string | null;
}>;

export type AdminDiagnosticComponent = Readonly<{
  id: string;
  group: AdminDiagnosticGroup;
  label: string;
  description: string;
  state: AdminDiagnosticState;
  checkedAt: string;
  durationMs: number;
  evidence: readonly AdminDiagnosticEvidence[];
  safeErrorCode: string | null;
  lastSuccessAt: string | null;
  metrics?: Readonly<Record<string, unknown>>;
  queues?: readonly AdminQueueSnapshot[];
  affectedSections?: readonly string[];
  links?: readonly Readonly<{ label: string; href: string }>[];
}>;

export type AdminSystemDiagnostics = Readonly<{
  schemaVersion: 1;
  checkedAt: string;
  durationMs: number;
  state: AdminDiagnosticState;
  summary: Readonly<{
    total: number;
    healthy: number;
    configured: number;
    warnings: number;
    critical: number;
  }>;
  release: ReturnType<typeof auroraReleaseMetadata>;
  components: readonly AdminDiagnosticComponent[];
}>;

export const ADMIN_QUEUE_NAMES = Object.freeze([
  "publish",
  "stats",
  "media-generation",
  "autopilot-plans",
  "site-analysis",
  "site-articles",
  "project-export",
  "publication-extra",
  "monthly-campaign-regeneration",
  "legal-visual-render",
  "publication-review-reminder",
  "cron",
]);

type DiagnosticPayload = Readonly<{
  state: AdminDiagnosticState;
  evidence: readonly AdminDiagnosticEvidence[];
  safeErrorCode?: string | null;
  lastSuccessAt?: string | null;
  metrics?: Readonly<Record<string, unknown>>;
  queues?: readonly AdminQueueSnapshot[];
  affectedSections?: readonly string[];
  links?: readonly Readonly<{ label: string; href: string }>[];
}>;

export type DiagnosticDefinition = Readonly<{
  id: string;
  group: AdminDiagnosticGroup;
  label: string;
  description: string;
  run: () => Promise<DiagnosticPayload>;
}>;

const lastSuccessByComponent = new Map<string, string>();

const WEB_EVENT_LOOP_LAG_WARNING_MS = 250;
const WEB_EVENT_LOOP_LAG_CRITICAL_MS = 2_000;
const AI_RECENT_WINDOW_MINUTES = 15;
const AI_QUIET_SUCCESS_MAX_AGE_MS = 24 * 60 * 60_000;
const REDIS_PING_WARNING_MS = 100;

/** How long a zero-delay timer waits before firing: a direct measure of process saturation. */
export async function measureEventLoopLag(now: () => number = Date.now): Promise<number> {
  const startedAt = now();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return Math.max(0, Math.round(now() - startedAt) - 1);
}

function safeCode(value: unknown, fallback: string): string {
  const normalized = String(value || "").trim();
  return /^[a-z0-9_]{1,100}$/u.test(normalized) ? normalized : fallback;
}

function nonNegative(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
}

function nullableIso(value: unknown): string | null {
  if (value == null) return null;
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function ageMs(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, nowMs - timestamp) : null;
}

function heartbeatAt(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { at?: unknown };
    return typeof parsed?.at === "string" ? nullableIso(parsed.at) : null;
  } catch {
    return null;
  }
}

export async function runDiagnosticDefinitions(
  definitions: readonly DiagnosticDefinition[],
  options: { now?: () => number } = {},
): Promise<AdminDiagnosticComponent[]> {
  const now = options.now ?? Date.now;
  const settled = await Promise.allSettled(definitions.map(async (definition) => {
    const startedAt = now();
    const payload = await definition.run();
    return { definition, payload, durationMs: Math.max(0, Math.round(now() - startedAt)) };
  }));
  const checkedAt = new Date(now()).toISOString();

  return settled.map((result, index) => {
    const definition = definitions[index];
    if (result.status === "rejected") {
      return {
        id: definition.id,
        group: definition.group,
        label: definition.label,
        description: definition.description,
        state: "down",
        checkedAt,
        durationMs: 0,
        evidence: [{ label: "Проверка", value: "Не завершена", tone: "critical" }],
        safeErrorCode: `${definition.id}_check_failed`,
        lastSuccessAt: lastSuccessByComponent.get(definition.id) ?? null,
      } satisfies AdminDiagnosticComponent;
    }
    const { payload, durationMs } = result.value;
    const successfulAt = payload.lastSuccessAt
      ?? (payload.state === "healthy" ? checkedAt : null);
    if (successfulAt) lastSuccessByComponent.set(definition.id, successfulAt);
    return {
      id: definition.id,
      group: definition.group,
      label: definition.label,
      description: definition.description,
      state: payload.state,
      checkedAt,
      durationMs,
      evidence: payload.evidence,
      safeErrorCode: payload.safeErrorCode ?? null,
      lastSuccessAt: successfulAt ?? lastSuccessByComponent.get(definition.id) ?? null,
      ...(payload.metrics ? { metrics: payload.metrics } : {}),
      ...(payload.queues ? { queues: payload.queues } : {}),
      ...(payload.affectedSections ? { affectedSections: payload.affectedSections } : {}),
      ...(payload.links ? { links: payload.links } : {}),
    } satisfies AdminDiagnosticComponent;
  });
}

function parseRedisInfo(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/gu)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

type RedisSnapshot = Readonly<{
  configured: boolean;
  pingLatencyMs: number | null;
  usedMemoryBytes: number | null;
  uptimeSeconds: number | null;
  connectedClients: number | null;
  publicationHeartbeatRaw: string | null;
  telegramHeartbeatRaw: string | null;
}>;

async function probeRedis(now: () => number): Promise<RedisSnapshot> {
  const url = String(process.env.REDIS_URL || "").trim();
  if (!url) {
    return {
      configured: false,
      pingLatencyMs: null,
      usedMemoryBytes: null,
      uptimeSeconds: null,
      connectedClients: null,
      publicationHeartbeatRaw: null,
      telegramHeartbeatRaw: null,
    };
  }
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 1_500,
    commandTimeout: 1_500,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
  });
  client.on("error", () => undefined);
  try {
    await client.connect();
    const startedAt = now();
    await client.ping();
    const pingLatencyMs = Math.max(0, Math.round(now() - startedAt));
    const [infoRaw, heartbeats] = await Promise.all([
      client.info("memory", "server", "clients"),
      client.mget(PUBLICATION_HEARTBEAT_KEY, TELEGRAM_POLLING_HEARTBEAT_KEY),
    ]);
    const info = parseRedisInfo(infoRaw);
    return {
      configured: true,
      pingLatencyMs,
      usedMemoryBytes: info.used_memory == null ? null : nonNegative(info.used_memory),
      uptimeSeconds: info.uptime_in_seconds == null ? null : nonNegative(info.uptime_in_seconds),
      connectedClients: info.connected_clients == null ? null : nonNegative(info.connected_clients),
      publicationHeartbeatRaw: heartbeats[0] ?? null,
      telegramHeartbeatRaw: heartbeats[1] ?? null,
    };
  } finally {
    client.disconnect(false);
  }
}

async function probeOneQueue(name: string, nowMs: number): Promise<AdminQueueSnapshot> {
  const queue = new Queue(name, { connection: redisProducerConnectionOptions() });
  try {
    const [counts, workers, jobs] = await Promise.all([
      queue.getJobCounts("wait", "active", "delayed", "completed", "failed"),
      queue.getWorkersCount(),
      queue.getJobs(["wait", "active", "delayed"], 0, 99, true),
    ]);
    const oldestTimestamp = jobs.reduce<number | null>((oldest, job) => {
      const timestamp = Number(job.timestamp);
      if (!Number.isFinite(timestamp)) return oldest;
      return oldest === null ? timestamp : Math.min(oldest, timestamp);
    }, null);
    const pending = nonNegative(counts.wait) + nonNegative(counts.active) + nonNegative(counts.delayed);
    const failures = nonNegative(counts.failed);
    return {
      name,
      state: workers > 0 ? (failures > 0 ? "degraded" : "healthy") : pending > 0 ? "down" : "unobserved",
      workers: nonNegative(workers),
      waiting: nonNegative(counts.wait),
      active: nonNegative(counts.active),
      delayed: nonNegative(counts.delayed),
      completed: nonNegative(counts.completed),
      failed: failures,
      oldestJobAgeMs: oldestTimestamp === null ? null : Math.max(0, nowMs - oldestTimestamp),
      safeErrorCode: failures > 0 ? "queue_failed_jobs" : workers === 0 && pending > 0 ? "queue_worker_missing" : null,
    };
  } catch {
    return {
      name,
      state: "down",
      workers: null,
      waiting: null,
      active: null,
      delayed: null,
      completed: null,
      failed: null,
      oldestJobAgeMs: null,
      safeErrorCode: "queue_probe_failed",
    };
  } finally {
    await queue.close().catch(() => undefined);
  }
}

export async function probeAdminQueues(nowMs = Date.now()): Promise<AdminQueueSnapshot[]> {
  if (!String(process.env.REDIS_URL || "").trim()) {
    return ADMIN_QUEUE_NAMES.map((name) => ({
      name,
      state: "not_configured",
      workers: null,
      waiting: null,
      active: null,
      delayed: null,
      completed: null,
      failed: null,
      oldestJobAgeMs: null,
      safeErrorCode: null,
    }));
  }
  const settled = await Promise.allSettled(ADMIN_QUEUE_NAMES.map((name) => probeOneQueue(name, nowMs)));
  return settled.map((result, index) => result.status === "fulfilled" ? result.value : ({
    name: ADMIN_QUEUE_NAMES[index],
    state: "down",
    workers: null,
    waiting: null,
    active: null,
    delayed: null,
    completed: null,
    failed: null,
    oldestJobAgeMs: null,
    safeErrorCode: "queue_probe_failed",
  }));
}

async function publicationMetrics(pool: Pool) {
  const result = await pool.query<{
    waiting: number | string;
    active: number | string;
    overdue: number | string;
    successes: number | string;
    failures: number | string;
    average_duration_ms: number | string | null;
    last_success_at: Date | string | null;
    last_error_code: string | null;
  }>(
    `select
       count(*) filter (where status = 'scheduled') as waiting,
       count(*) filter (where status = 'publishing') as active,
       count(*) filter (where status = 'scheduled' and scheduled_at < now() - interval '5 minutes') as overdue,
       count(*) filter (where status = 'published' and published_at >= now() - interval '24 hours') as successes,
       count(*) filter (where status = 'failed' and updated_at >= now() - interval '24 hours') as failures,
       avg(extract(epoch from (published_at - provider_started_at)) * 1000)
         filter (where status = 'published' and provider_started_at is not null
           and published_at >= now() - interval '24 hours') as average_duration_ms,
       max(published_at) filter (where status = 'published') as last_success_at,
       (array_agg(coalesce(verification_error_code, 'provider_error') order by updated_at desc)
         filter (where status = 'failed'))[1] as last_error_code
     from posts`,
  );
  const row = result.rows[0];
  return {
    waiting: nonNegative(row?.waiting),
    active: nonNegative(row?.active),
    overdue: nonNegative(row?.overdue),
    successes: nonNegative(row?.successes),
    failures: nonNegative(row?.failures),
    averageDurationMs: row?.average_duration_ms == null ? null : nonNegative(row.average_duration_ms),
    lastSuccessAt: nullableIso(row?.last_success_at),
    lastErrorCode: row?.last_error_code ? safeCode(row.last_error_code, "provider_error") : null,
  };
}

async function mailMetrics(pool: Pool) {
  const result = await pool.query<{
    sent: number | string;
    failed: number | string;
    last_success_at: Date | string | null;
    last_error_code: string | null;
  }>(
    `select
       count(*) filter (where status = 'sent' and sent_at >= now() - interval '30 days') as sent,
       count(*) filter (where status = 'failed' and updated_at >= now() - interval '24 hours') as failed,
       max(sent_at) filter (where status = 'sent') as last_success_at,
       (array_agg(last_error_code order by updated_at desc)
         filter (where status = 'failed' and last_error_code is not null))[1] as last_error_code
     from password_reset_outbox`,
  );
  const row = result.rows[0];
  return {
    sent: nonNegative(row?.sent),
    failed: nonNegative(row?.failed),
    lastSuccessAt: nullableIso(row?.last_success_at),
    lastErrorCode: row?.last_error_code ? safeCode(row.last_error_code, "mail_delivery_failed") : null,
  };
}

function queueByName(queues: readonly AdminQueueSnapshot[], name: string) {
  return queues.find((queue) => queue.name === name) ?? null;
}

function queueState(queues: readonly AdminQueueSnapshot[], names: readonly string[]): AdminDiagnosticState {
  const selected = names.map((name) => queueByName(queues, name)).filter(Boolean) as AdminQueueSnapshot[];
  if (selected.some((queue) => queue.state === "down")) return "down";
  if (selected.some((queue) => queue.state === "degraded")) return "degraded";
  if (selected.length > 0 && selected.every((queue) => queue.state === "not_configured")) return "not_configured";
  if (selected.some((queue) => queue.state === "healthy")) return "healthy";
  return "unobserved";
}

/**
 * Component ids that `/admin?system=<id>` can select. Section dependencies in
 * `aurora-section-catalog.ts` must only reference these, otherwise cross-links from
 * analytics land on an empty detail panel.
 */
export const ADMIN_DIAGNOSTIC_COMPONENT_IDS = Object.freeze([
  "web_api",
  "postgresql",
  "database_schema",
  "redis",
  "publication_worker",
  "telegram_worker",
  "aurora_ai",
  "media_generation",
  "site_analysis",
  "mail_delivery",
  "token_encryption",
  "tracking_secrets",
  "upload_limits",
  "https_origin",
  "current_release",
] as const);

export type AdminDiagnosticComponentId = (typeof ADMIN_DIAGNOSTIC_COMPONENT_IDS)[number];

export function defaultDiagnosticComponentIds(now: () => number = Date.now): string[] {
  return defaultDefinitions(now).map((definition) => definition.id);
}

function defaultDefinitions(now: () => number): DiagnosticDefinition[] {
  const pool = () => getPool();
  let redisPromise: Promise<RedisSnapshot> | null = null;
  let queuesPromise: Promise<AdminQueueSnapshot[]> | null = null;
  const redis = () => redisPromise ??= probeRedis(now);
  const queues = () => queuesPromise ??= probeAdminQueues(now());

  return [
    {
      id: "web_api", group: "core", label: "Web/API", description: "Текущий HTTP-процесс: event loop, память, uptime",
      run: async () => {
        const lagMs = await measureEventLoopLag(now);
        const memory = process.memoryUsage();
        const uptimeSeconds = Math.round(process.uptime());
        const state: AdminDiagnosticState = lagMs >= WEB_EVENT_LOOP_LAG_CRITICAL_MS ? "down"
          : lagMs >= WEB_EVENT_LOOP_LAG_WARNING_MS ? "degraded" : "healthy";
        return {
          state,
          evidence: [
            { label: "Задержка event loop", value: `${lagMs} мс`, tone: state === "healthy" ? "positive" : state === "down" ? "critical" : "warning" },
            { label: "Uptime процесса", value: uptimeSeconds },
            { label: "Память RSS", value: memory.rss },
          ],
          safeErrorCode: state === "healthy" ? null : "web_event_loop_lag",
          metrics: {
            eventLoopLagMs: lagMs,
            processUptimeSeconds: uptimeSeconds,
            rssBytes: memory.rss,
            heapUsedBytes: memory.heapUsed,
            heapTotalBytes: memory.heapTotal,
          },
          affectedSections: [],
        };
      },
    },
    {
      id: "postgresql", group: "core", label: "PostgreSQL", description: "Доступность и пул соединений",
      run: async () => {
        if (!process.env.DATABASE_URL) return { state: "not_configured", evidence: [{ label: "DATABASE_URL", value: "Не настроен" }] };
        const startedAt = now();
        await pool().query("select 1 as ok");
        const latencyMs = Math.max(0, Math.round(now() - startedAt));
        const snapshot = getDatabasePoolSnapshot();
        const state: AdminDiagnosticState = snapshot.waiting > 0 || snapshot.acquireTimeouts > 0 || snapshot.acquireErrors > 0
          ? "degraded" : "healthy";
        return {
          state,
          evidence: [
            { label: "PING", value: `${latencyMs} мс`, tone: state === "healthy" ? "positive" : "warning" },
            { label: "Последний успешный запрос", value: new Date(now()).toISOString() },
          ],
          safeErrorCode: state === "degraded" ? "database_pool_pressure" : null,
          metrics: { latencyMs, ...snapshot },
          affectedSections: [],
        };
      },
    },
    {
      id: "database_schema", group: "core", label: "Схема базы", description: "Версия, миграции и capabilities",
      run: async () => {
        const result = await probeDatabaseAndSchema();
        if (result.database === "not_configured") {
          return { state: "not_configured", evidence: [{ label: "Схема", value: "База не настроена" }] };
        }
        const state: AdminDiagnosticState = result.database === "down" ? "down" : result.schema.ready ? "healthy" : "degraded";
        return {
          state,
          evidence: [
            { label: "Ожидаемая версия", value: result.schema.expectedVersion },
            { label: "Текущая версия", value: result.schema.actualVersion },
            { label: "Миграции", value: `${result.schema.appliedMigrations} / ${result.schema.expectedMigrations}` },
          ],
          safeErrorCode: result.schema.reasons[0] ? safeCode(result.schema.reasons[0].replace(/[:.]/gu, "_"), "schema_mismatch") : null,
          metrics: {
            expectedVersion: result.schema.expectedVersion,
            actualVersion: result.schema.actualVersion,
            appliedMigrations: result.schema.appliedMigrations,
            expectedMigrations: result.schema.expectedMigrations,
            reasons: result.schema.reasons.slice(0, 20),
          },
          affectedSections: [],
        };
      },
    },
    {
      id: "redis", group: "core", label: "Redis", description: "PING, память, uptime и очереди",
      run: async () => {
        const [snapshot, queueSnapshots] = await Promise.all([redis(), queues()]);
        if (!snapshot.configured) return { state: "not_configured", evidence: [{ label: "REDIS_URL", value: "Не настроен" }], queues: queueSnapshots };
        const failedQueues = queueSnapshots.filter((queue) => queue.state === "down").length;
        const slowPing = snapshot.pingLatencyMs != null && snapshot.pingLatencyMs >= REDIS_PING_WARNING_MS;
        return {
          state: failedQueues > 0 || slowPing ? "degraded" : "healthy",
          evidence: [
            {
              label: "PING",
              value: snapshot.pingLatencyMs == null ? null : `${snapshot.pingLatencyMs} мс`,
              tone: snapshot.pingLatencyMs == null ? "warning" : slowPing ? "warning" : "positive",
            },
            { label: "Подключения", value: snapshot.connectedClients },
          ],
          safeErrorCode: failedQueues > 0 ? "redis_queue_probe_partial" : slowPing ? "redis_ping_slow" : null,
          metrics: {
            pingLatencyMs: snapshot.pingLatencyMs,
            usedMemoryBytes: snapshot.usedMemoryBytes,
            uptimeSeconds: snapshot.uptimeSeconds,
            connectedClients: snapshot.connectedClients,
          },
          queues: queueSnapshots,
          affectedSections: failedQueues > 0 ? ["calendar", "autopilot", "siteAnalysis", "analytics"] : [],
        };
      },
    },
    {
      id: "publication_worker", group: "core", label: "Воркер публикаций", description: "Heartbeat, очередь и подтверждённые публикации",
      run: async () => {
        const [snapshot, queueSnapshots, metrics] = await Promise.all([redis(), queues(), publicationMetrics(pool())]);
        if (!snapshot.configured) return { state: "not_configured", evidence: [{ label: "Redis", value: "Не настроен" }] };
        const parsed = parsePublicationHeartbeat(snapshot.publicationHeartbeatRaw, { nowMs: now() });
        const observedAt = parsed?.at ?? heartbeatAt(snapshot.publicationHeartbeatRaw);
        const heartbeatAgeMs = ageMs(observedAt, now());
        const publishQueue = queueByName(queueSnapshots, "publish");
        const state: AdminDiagnosticState = !parsed ? "down"
          : metrics.overdue > 0 || metrics.failures > 0 || publishQueue?.state === "degraded" ? "degraded" : "healthy";
        return {
          state,
          evidence: [
            { label: "Heartbeat", value: observedAt, tone: parsed ? "positive" : "critical" },
            { label: "Возраст heartbeat", value: heartbeatAgeMs },
            { label: "Допустимый интервал", value: PUBLICATION_HEARTBEAT_TTL_SECONDS * 1_000 },
            { label: "Последняя успешная публикация", value: metrics.lastSuccessAt },
          ],
          safeErrorCode: !parsed ? "publication_heartbeat_stale" : metrics.lastErrorCode,
          lastSuccessAt: metrics.lastSuccessAt ?? parsed?.at ?? null,
          metrics: {
            heartbeatAgeMs,
            heartbeatIntervalMs: PUBLICATION_HEARTBEAT_INTERVAL_MS,
            heartbeatMaxAgeMs: PUBLICATION_HEARTBEAT_TTL_SECONDS * 1_000,
            ...metrics,
          },
          queues: publishQueue ? [publishQueue] : [],
          affectedSections: ["calendar", "composer", "autopilot"],
          links: [
            { label: "Открыть проблемные публикации", href: "/admin#publications" },
            { label: "Открыть очередь", href: "/admin?system=redis#system" },
            { label: "Открыть журнал", href: "/admin#audit" },
          ],
        };
      },
    },
    {
      id: "telegram_worker", group: "integrations", label: "Telegram-воркер", description: "Polling heartbeat и конфликт владельца",
      run: async () => {
        if (!String(process.env.TG_BOT_TOKEN || "").trim()) {
          return { state: "not_configured", evidence: [{ label: "Telegram", value: "Не настроен" }] };
        }
        const snapshot = await redis();
        if (!snapshot.configured) return { state: "down", evidence: [{ label: "Redis", value: "Недоступен", tone: "critical" }], safeErrorCode: "telegram_redis_unavailable" };
        const parsed = parseTelegramPollingHeartbeat(snapshot.telegramHeartbeatRaw, { nowMs: now() });
        const observedAt = parsed?.at ?? heartbeatAt(snapshot.telegramHeartbeatRaw);
        const state: AdminDiagnosticState = parsed?.state === "conflict" ? "conflict" : parsed?.state === "up" ? "healthy" : "down";
        return {
          state,
          evidence: [
            { label: "Heartbeat", value: observedAt, tone: state === "healthy" ? "positive" : "critical" },
            { label: "Возраст heartbeat", value: ageMs(observedAt, now()) },
            { label: "Допустимый интервал", value: TELEGRAM_POLLING_HEARTBEAT_TTL_SECONDS * 1_000 },
          ],
          safeErrorCode: state === "conflict" ? "telegram_polling_conflict" : state === "down" ? "telegram_heartbeat_stale" : null,
          lastSuccessAt: parsed?.state === "up" ? parsed.at : null,
          affectedSections: ["settings"],
        };
      },
    },
    {
      id: "aurora_ai", group: "integrations", label: "Aurora AI", description: "Провайдеры, circuit state и использование",
      run: async () => {
        if (!probeAiConfiguration()) return { state: "not_configured", evidence: [{ label: "Провайдеры", value: "Не настроены" }] };
        const providers = aiProviderHealthSnapshot(now());
        const usageResult = await pool().query<{
          provider: string;
          model: string;
          successes: number | string;
          failures: number | string;
          average_latency_ms: number | string | null;
          last_success_at: Date | string | null;
        }>(
          `select provider, model,
                  count(*) filter (where outcome = 'succeeded') as successes,
                  count(*) filter (where outcome = 'failed') as failures,
                  avg(latency_ms) as average_latency_ms,
                  max(created_at) filter (where outcome = 'succeeded') as last_success_at
             from ai_provider_attempts
            where created_at >= now() - interval '30 days'
            group by provider, model
            order by provider, model`,
        );
        const [usage, recent] = await Promise.all([
          pool().query<{ today: number | string; period: number | string }>(
            `select
               count(*) filter (where status = 'committed' and usage_date = current_date) as today,
               count(*) filter (where status = 'committed' and created_at >= now() - interval '30 days') as period
             from ai_usage`,
          ),
          // Persisted attempts cover both the web and worker processes, unlike the in-process
          // circuit snapshot which only sees calls made by this HTTP process.
          pool().query<{ successes: number | string; failures: number | string }>(
            `select
               count(*) filter (where outcome = 'succeeded') as successes,
               count(*) filter (where outcome = 'failed') as failures
             from ai_provider_attempts
            where created_at >= now() - make_interval(mins => $1::int)`,
            [AI_RECENT_WINDOW_MINUTES],
          ),
        ]);
        const latestSuccess = usageResult.rows.map((row) => nullableIso(row.last_success_at)).filter(Boolean).sort().at(-1) ?? null;
        const latestSuccessAgeMs = ageMs(latestSuccess, now());
        const recentSuccesses = nonNegative(recent.rows[0]?.successes);
        const recentFailures = nonNegative(recent.rows[0]?.failures);
        const openCircuit = providers.find((provider) => provider.state === "open");
        // A quiet period (no calls in the window) is not a failure; healthy is kept while the
        // last confirmed success is recent enough, otherwise the component is unobserved.
        const state: AdminDiagnosticState = openCircuit ? "degraded"
          : recentSuccesses + recentFailures > 0
            ? (recentFailures > 0 && recentSuccesses === 0 ? "degraded" : "healthy")
            : latestSuccessAgeMs != null && latestSuccessAgeMs <= AI_QUIET_SUCCESS_MAX_AGE_MS ? "healthy" : "unobserved";
        const safeErrorCode = openCircuit ? (openCircuit.lastFailureCode ?? "ai_circuit_open")
          : state === "degraded" ? (providers.find((provider) => provider.lastFailureCode)?.lastFailureCode ?? "ai_recent_failures")
            : null;
        return {
          state,
          evidence: [
            { label: "Настроенные провайдеры", value: providers.length || usageResult.rows.length },
            { label: `Вызовы за ${AI_RECENT_WINDOW_MINUTES} мин`, value: `${recentSuccesses} успешных · ${recentFailures} с ошибкой`, tone: recentFailures > 0 && recentSuccesses === 0 ? "critical" : recentFailures > 0 ? "warning" : "neutral" },
            { label: "Последний успешный outcome", value: latestSuccess },
          ],
          safeErrorCode,
          lastSuccessAt: latestSuccess,
          metrics: {
            recentSuccesses,
            recentFailures,
            providers,
            activeModels: usageResult.rows.map((row) => ({
              provider: row.provider,
              model: row.model,
              successes: nonNegative(row.successes),
              failures: nonNegative(row.failures),
              averageLatencyMs: row.average_latency_ms == null ? null : nonNegative(row.average_latency_ms),
              lastSuccessAt: nullableIso(row.last_success_at),
            })),
            usageToday: nonNegative(usage.rows[0]?.today),
            usagePeriod: nonNegative(usage.rows[0]?.period),
          },
          affectedSections: ["studio", "autopilot", "knowledge", "opportunities", "siteAnalysis"],
        };
      },
    },
    {
      id: "media_generation", group: "integrations", label: "Генерация медиа", description: "Очередь и terminal outcomes",
      run: async () => {
        const queueSnapshots = await queues();
        const selected = ["media-generation", "legal-visual-render"].map((name) => queueByName(queueSnapshots, name)).filter(Boolean) as AdminQueueSnapshot[];
        return {
          state: queueState(queueSnapshots, ["media-generation", "legal-visual-render"]),
          evidence: [{ label: "Очереди", value: selected.length }],
          safeErrorCode: selected.find((queue) => queue.safeErrorCode)?.safeErrorCode ?? null,
          queues: selected,
          affectedSections: ["studio", "composer", "rss"],
        };
      },
    },
    {
      id: "site_analysis", group: "integrations", label: "Анализ сайтов", description: "Очередь, worker и доменные стадии",
      run: async () => {
        const queueSnapshots = await queues();
        const selected = queueByName(queueSnapshots, "site-analysis");
        const result = await pool().query<{ running: number | string; failed: number | string; last_success_at: Date | string | null }>(
          `select count(*) filter (where status in ('queued','running')) as running,
                  count(*) filter (where status = 'failed' and updated_at >= now() - interval '24 hours') as failed,
                  max(completed_at) filter (where status = 'ready') as last_success_at
             from site_analysis_jobs`,
        );
        const row = result.rows[0];
        const failed = nonNegative(row?.failed);
        const base = queueState(queueSnapshots, ["site-analysis"]);
        const state: AdminDiagnosticState = failed > 0 && base === "healthy" ? "degraded" : base;
        return {
          state,
          evidence: [{ label: "Последний готовый отчёт", value: nullableIso(row?.last_success_at) }],
          safeErrorCode: failed > 0 ? "site_analysis_recent_failures" : selected?.safeErrorCode ?? null,
          lastSuccessAt: nullableIso(row?.last_success_at),
          metrics: { running: nonNegative(row?.running), failed },
          queues: selected ? [selected] : [],
          affectedSections: ["siteAnalysis"],
        };
      },
    },
    {
      id: "mail_delivery", group: "integrations", label: "Почтовая доставка", description: "Конфигурация и подтверждённые отправки",
      run: async () => {
        const configured = probeMailDeliveryConfiguration();
        if (configured === "not_configured") return { state: "not_configured", evidence: [{ label: "Почта", value: "Не настроена" }] };
        const metrics = await mailMetrics(pool());
        const state: AdminDiagnosticState = metrics.failed > 0 ? "degraded" : metrics.lastSuccessAt ? "healthy" : "unobserved";
        return {
          state,
          evidence: [{ label: "Подтверждённая доставка", value: metrics.lastSuccessAt }],
          safeErrorCode: metrics.lastErrorCode,
          lastSuccessAt: metrics.lastSuccessAt,
          metrics,
          affectedSections: ["settings"],
        };
      },
    },
    {
      id: "token_encryption", group: "security", label: "Шифрование токенов", description: "Keyring и известные envelope key IDs",
      run: async () => {
        const result = await probeDatabaseAndSchema();
        const state: AdminDiagnosticState = result.tokenEncryption === "up" ? "healthy"
          : result.tokenEncryption === "not_configured" ? "not_configured" : "down";
        return {
          state,
          evidence: [{ label: "Проверка keyring", value: result.tokenEncryption === "up" ? "Совпадает" : "Не подтверждена" }],
          safeErrorCode: state === "down" ? "token_envelope_key_unknown" : null,
        };
      },
    },
    {
      id: "tracking_secrets", group: "security", label: "Tracking secrets", description: "Наличие, длина и разделение секретов",
      run: async () => {
        const result = probeTrackingSecretsConfiguration();
        const state: AdminDiagnosticState = result === "up" ? "configured" : result === "not_configured" ? "not_configured" : "down";
        return {
          state,
          evidence: [{ label: "Проверка конфигурации", value: state === "configured" ? "Секреты заданы и различаются" : "Не пройдена" }],
          safeErrorCode: state === "down" ? "tracking_secrets_invalid" : null,
        };
      },
    },
    {
      id: "upload_limits", group: "security", label: "Ограничения загрузки", description: "Ingress body limit",
      run: async () => {
        const result = probeUploadIngressConfiguration();
        const state: AdminDiagnosticState = result === "up" ? "configured" : "not_configured";
        return {
          state,
          evidence: [{ label: "Ingress limit", value: state === "configured" ? "Задан" : "Не настроен" }],
          safeErrorCode: state === "not_configured" ? "avatar_ingress_limit_not_configured" : null,
        };
      },
    },
    {
      id: "https_origin", group: "security", label: "HTTPS/origin", description: "Канонический browser mutation origin",
      run: async () => {
        const value = String(process.env.APP_URL || "").trim();
        if (!value) return { state: "not_configured", evidence: [{ label: "APP_URL", value: "Не настроен" }] };
        let protocol: string;
        try { protocol = new URL(value).protocol; } catch { return { state: "down", evidence: [{ label: "APP_URL", value: "Некорректен" }], safeErrorCode: "app_origin_invalid" }; }
        const secure = protocol === "https:";
        const state: AdminDiagnosticState = secure ? "configured" : process.env.NODE_ENV === "production" ? "down" : "degraded";
        return {
          state,
          evidence: [{ label: "Протокол", value: protocol.replace(":", "") }],
          safeErrorCode: secure ? null : "app_origin_not_https",
        };
      },
    },
    {
      id: "current_release", group: "security", label: "Текущий релиз", description: "Версия, commit и время развёртывания",
      run: async () => {
        const release = auroraReleaseMetadata();
        if (!release.release) return { state: "not_configured", evidence: [{ label: "Релиз", value: "Не настроен" }] };
        const complete = Boolean(release.commitSha && release.deployedAt);
        return {
          state: complete ? "healthy" : "degraded",
          evidence: [
            { label: "Версия", value: release.release },
            { label: "Commit", value: release.commitSha },
            { label: "Развёрнут", value: release.deployedAt },
          ],
          safeErrorCode: complete ? null : "release_metadata_incomplete",
          lastSuccessAt: release.deployedAt,
        };
      },
    },
  ];
}

export async function loadAdminSystemDiagnostics(
  options: { now?: () => number; definitions?: readonly DiagnosticDefinition[] } = {},
): Promise<AdminSystemDiagnostics> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const components = await runDiagnosticDefinitions(options.definitions ?? defaultDefinitions(now), { now });
  const healthy = components.filter((component) => component.state === "healthy").length;
  const configured = components.filter((component) => component.state === "configured").length;
  const critical = components.filter((component) => component.state === "down" || component.state === "conflict").length;
  const warnings = components.length - healthy - configured - critical;
  const coreCritical = components.some((component) => component.group === "core" && (component.state === "down" || component.state === "conflict"));
  const state: AdminDiagnosticState = coreCritical ? "down" : critical > 0 || warnings > 0 ? "degraded" : "healthy";
  return {
    schemaVersion: 1,
    checkedAt: new Date(now()).toISOString(),
    durationMs: Math.max(0, Math.round(now() - startedAt)),
    state,
    summary: { total: components.length, healthy, configured, warnings, critical },
    release: auroraReleaseMetadata(),
    components,
  };
}
