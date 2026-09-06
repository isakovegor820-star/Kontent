import { Queue } from "bullmq";
import { CRON_SCHEDULES } from "../../worker/cron-schedules.mjs";
import Redis, { type RedisOptions } from "ioredis";
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
  "unavailable",
  "stale",
  "not_used",
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
  prioritized?: number | null;
  paused?: boolean | null;
  waitingChildren?: number | null;
  sampledJobs?: number;
  unmeasuredWaitingJobs?: number;
  sampleLimitPerState?: number;
  lastCompletedAt?: string | null;
  lastFailedAt?: string | null;
  schedulers?: number | null;
  missingSchedulers?: readonly string[];
}>;

export type AdminDiagnosticHistory = Readonly<{
  code: string; count: number; firstSeenAt: string | null; lastSeenAt: string | null;
  affectedRecords: number; examples: readonly string[];
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
  validUntil?: string;
  scope?: string;
  history?: readonly AdminDiagnosticHistory[];
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
  environment?: "local" | "staging" | "production" | "unknown";
  runtimeMode?: string;
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
  validUntil?: string;
  scope?: string;
  history?: readonly AdminDiagnosticHistory[];
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

const WEB_EVENT_LOOP_LAG_WARNING_MS = 250;
const WEB_EVENT_LOOP_LAG_CRITICAL_MS = 2_000;
const EXECUTION_MAX_AGE_MS = 15 * 60_000;
const SNAPSHOT_MAX_AGE_MS = 60_000;
const CHECK_TIMEOUT_MS = 7_000;
const REDIS_PING_WARNING_MS = 100;

class DiagnosticTimeout extends Error {}

async function bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DiagnosticTimeout()), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

function observationState(lastSuccess: string | null, nowMs: number, maxAgeMs = EXECUTION_MAX_AGE_MS): AdminDiagnosticState {
  if (!lastSuccess) return "unobserved";
  const timestamp = Date.parse(lastSuccess);
  if (!Number.isFinite(timestamp) || timestamp > nowMs + 10_000) return "unavailable";
  return nowMs - timestamp >= maxAgeMs ? "stale" : "healthy";
}

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
  if (value == null || !Number.isFinite(parsed) || parsed < 0) throw new Error("diagnostic_metric_invalid");
  return Math.round(parsed);
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
  options: { now?: () => number; timeoutMs?: number } = {},
): Promise<AdminDiagnosticComponent[]> {
  const now = options.now ?? Date.now;
  return Promise.all(definitions.map(async (definition): Promise<AdminDiagnosticComponent> => {
    const startedAt = now();
    try {
      const payload = await bounded(Promise.resolve().then(definition.run), options.timeoutMs ?? CHECK_TIMEOUT_MS);
      const completedAt = now();
      const checkedAt = new Date(completedAt).toISOString();
      return {
        id: definition.id, group: definition.group, label: definition.label, description: definition.description,
        ...payload,
        checkedAt,
        durationMs: Math.max(0, Math.round(completedAt - startedAt)),
        validUntil: new Date(Math.min(completedAt + SNAPSHOT_MAX_AGE_MS,
          payload.validUntil ? Date.parse(payload.validUntil) : Infinity)).toISOString(),
        safeErrorCode: payload.safeErrorCode ?? null,
        // Only this check or durable source evidence can establish success. A process-local
        // cache would mix runtime targets in tests and disappear across web replicas/restarts.
        lastSuccessAt: payload.lastSuccessAt ?? (payload.state === "healthy" ? checkedAt : null),
      };
    } catch (error) {
      const checkedAt = new Date(now()).toISOString();
      return {
        id: definition.id,
        group: definition.group,
        label: definition.label,
        description: definition.description,
        state: "unavailable",
        checkedAt,
        validUntil: new Date(now() + SNAPSHOT_MAX_AGE_MS).toISOString(),
        durationMs: Math.max(0, Math.round(now() - startedAt)),
        evidence: [{ label: "Проверка", value: error instanceof DiagnosticTimeout ? "Превышено время ожидания" : "Не завершена", tone: "warning" }],
        safeErrorCode: `${definition.id}_${error instanceof DiagnosticTimeout ? "check_timeout" : "check_failed"}`,
        lastSuccessAt: null,
      } satisfies AdminDiagnosticComponent;
    }
  }));
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
  const connection = { ...(redisProducerConnectionOptions() as RedisOptions), retryStrategy: () => null };
  const queue = new Queue(name, { connection, skipMetasUpdate: true });
  queue.on("error", () => undefined);
  try {
    // BullMQ's jobScheduler getter has an async Promise executor. Calling it while
    // initial connection fails can reject outside its returned Promise (5.80.x).
    await bounded(queue.waitUntilReady(), 2_500);
    const client = await queue.client;
    const [counts, clients, jobs, delayedScores, completed, failed, paused, schedulers] = await bounded(Promise.all([
      queue.getJobCounts("wait", "active", "delayed", "prioritized", "paused", "waiting-children", "completed", "failed"),
      queue.getWorkers(),
      // Bounded sample per state, explicitly labelled in the UI. Future scheduled jobs
      // are not queue delay; retries use the next eligible time, not original creation.
      queue.getJobs(["wait", "prioritized", "paused"], 0, 99, true),
      // BullMQ encodes due time in the sorted-set score (milliseconds * 4096).
      // Job.timestamp/processedOn + delay is not reliable after retry/backoff.
      client.zrange(queue.keys.delayed, 0, 99, { WITHSCORES: true }),
      queue.getJobs(["completed"], 0, 0, false),
      queue.getJobs(["failed"], 0, 0, false),
      queue.isPaused(),
      name === "cron" ? queue.getJobSchedulers(0, 99, true) : Promise.resolve(null),
    ]), 2_500);
    // CLIENT LIST spans all Redis logical databases. BullMQ matches queue names,
    // but does not filter db; a worker in another environment must not count.
    if (clients.some(client => client.db == null)) throw new Error("queue_worker_database_unavailable");
    const workers = clients.filter(client => Number(client.db) === (connection.db ?? 0)).length;
    // Once a retry has been promoted, BullMQ drops its due score. processedOn is
    // the previous attempt, not the time it re-entered wait. Do not invent an age.
    const unmeasuredWaitingJobs = jobs.filter(job => job.processedOn != null || job.attemptsMade > 0).length;
    const eligibleTimestamps = jobs.filter(job => job.processedOn == null && !job.attemptsMade).map(job => Number(job.timestamp));
    for (let index = 1; index < delayedScores.length; index += 2) {
      const score = Number(delayedScores[index]);
      if (!Number.isFinite(score)) throw new Error("queue_due_time_unavailable");
      eligibleTimestamps.push(Math.floor(score / 4096));
    }
    const oldestTimestamp = eligibleTimestamps.reduce<number | null>((oldest, timestamp) => {
      if (!Number.isFinite(timestamp) || timestamp > nowMs) return oldest;
      return oldest === null ? timestamp : Math.min(oldest, timestamp);
    }, null);
    const pending = [counts.wait, counts.active, counts.delayed, counts.prioritized, counts.paused, counts["waiting-children"]]
      .reduce((sum, value) => sum + nonNegative(value), 0);
    const lastCompletedAt = completed[0]?.finishedOn ? new Date(completed[0].finishedOn).toISOString() : null;
    const lastFailedAt = failed[0]?.finishedOn ? new Date(failed[0].finishedOn).toISOString() : null;
    const oldestJobAgeMs = oldestTimestamp === null ? null : Math.max(0, nowMs - oldestTimestamp);
    const recentFailure = lastFailedAt !== null && nowMs - Date.parse(lastFailedAt) < EXECUTION_MAX_AGE_MS
      && (!lastCompletedAt || lastFailedAt >= lastCompletedAt);
    const missingSchedulers = schedulers ? CRON_SCHEDULES.filter(expected => !schedulers.some(actual =>
      actual.key === expected.name && actual.pattern === expected.pattern && actual.tz === "Europe/Moscow",
    )).map(schedule => schedule.name) : [];
    const safeErrorCode = missingSchedulers.length ? "cron_schedule_missing_or_changed" : paused ? "queue_paused" : workers === 0 && pending > 0 ? "queue_worker_missing"
      : oldestJobAgeMs !== null && oldestJobAgeMs > 5 * 60_000 ? "queue_pending_overdue"
        : recentFailure ? "queue_recent_failure" : unmeasuredWaitingJobs ? "queue_wait_age_unavailable" : null;
    return {
      name,
      state: workers === 0 && pending > 0 ? "down" : safeErrorCode === "queue_wait_age_unavailable" ? "unobserved" : safeErrorCode ? "degraded"
        : workers === 0 ? "unobserved" : observationState(lastCompletedAt, nowMs),
      workers: nonNegative(workers),
      waiting: nonNegative(counts.wait) + nonNegative(counts.paused),
      active: nonNegative(counts.active),
      delayed: nonNegative(counts.delayed),
      prioritized: nonNegative(counts.prioritized),
      waitingChildren: nonNegative(counts["waiting-children"]),
      paused,
      completed: nonNegative(counts.completed),
      failed: nonNegative(counts.failed),
      oldestJobAgeMs,
      sampledJobs: jobs.length + delayedScores.length / 2,
      unmeasuredWaitingJobs,
      sampleLimitPerState: 100,
      schedulers: schedulers?.length ?? null, missingSchedulers,
      lastCompletedAt,
      lastFailedAt,
      safeErrorCode,
    };
  } catch {
    return {
      name, state: "unavailable", workers: null, waiting: null, active: null,
      delayed: null, completed: null, failed: null, oldestJobAgeMs: null,
      safeErrorCode: "queue_probe_failed",
    };
  } finally {
    // Disconnect also stops a failed connection attempt. Graceful close alone can wait
    // forever for Redis readiness, defeating the probe's deadline.
    await queue.disconnect().catch(() => undefined);
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
    state: "unavailable",
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

async function publicationMetrics(pool: Pool, checkedAt: string) {
  const result = await pool.query<{
    waiting: number | string;
    active: number | string;
    overdue: number | string;
    retrying: number | string;
    stuck: number | string;
    successes: number | string;
    failures: number | string;
    unverified: number | string;
    average_duration_ms: number | string | null;
    last_success_at: Date | string | null;
    last_error_code: string | null;
  }>(
    `select
       count(*) filter (where status = 'scheduled') as waiting,
       count(*) filter (where status = 'publishing') as active,
       count(*) filter (where (status = 'scheduled' and scheduled_at < $1::timestamptz - interval '5 minutes')
         or (status = 'failed_retry' and next_attempt_at < $1::timestamptz - interval '5 minutes')) as overdue,
       count(*) filter (where status = 'failed_retry') as retrying,
       count(*) filter (where status = 'publishing' and coalesce(publish_started_at, created_at) < $1::timestamptz - interval '15 minutes') as stuck,
       count(*) filter (where status = 'published' and published_at >= $1::timestamptz - interval '24 hours' and published_at <= $1::timestamptz) as successes,
       count(*) filter (where status = 'failed') as failures,
       count(*) filter (where status = 'published_unverified') as unverified,
       avg(extract(epoch from (published_at - provider_started_at)) * 1000)
         filter (where status = 'published' and provider_started_at is not null and published_at >= provider_started_at
           and published_at >= $1::timestamptz - interval '24 hours' and published_at <= $1::timestamptz) as average_duration_ms,
       max(published_at) filter (where status = 'published') as last_success_at,
       null::text as last_error_code
     from posts`,
    [checkedAt],
  );
  const row = result.rows[0];
  return {
    waiting: nonNegative(row?.waiting),
    active: nonNegative(row?.active),
    overdue: nonNegative(row?.overdue),
    retrying: nonNegative(row?.retrying),
    stuck: nonNegative(row?.stuck),
    successes: nonNegative(row?.successes),
    failures: nonNegative(row?.failures),
    unverified: nonNegative(row?.unverified),
    averageDurationMs: row?.average_duration_ms == null ? null : nonNegative(row.average_duration_ms),
    lastSuccessAt: nullableIso(row?.last_success_at),
    lastErrorCode: row?.last_error_code ? safeCode(row.last_error_code, "provider_error") : null,
  };
}

async function publicationErrorHistory(pool: Pool, checkedAt: string): Promise<AdminDiagnosticHistory[]> {
  const result = await pool.query<{
    error_code: string; events: string; first_at: Date; last_at: Date; affected: string; examples: string[];
  }>(
    `select e.error_code, count(*) as events, min(e.occurred_at) as first_at, max(e.occurred_at) as last_at,
       count(distinct p.id) filter (where p.status in ('failed','failed_retry','published_unverified')) as affected,
       (array_agg(distinct e.operation_id) filter (where e.operation_id is not null))[1:5] as examples
     from product_events e left join posts p on e.operation_id = 'post:' || p.id::text and p.project_id = e.project_id
     where e.section_id = 'calendar' and e.feature_id = 'publication' and e.outcome = 'failure'
       and e.occurred_at >= $1::timestamptz - interval '24 hours' and e.occurred_at <= $1::timestamptz
     group by e.error_code order by count(*) desc, e.error_code limit 20`, [checkedAt],
  );
  return result.rows.map(row => ({ code: safeCode(row.error_code, "provider_error"), count: nonNegative(row.events),
    firstSeenAt: nullableIso(row.first_at), lastSeenAt: nullableIso(row.last_at), affectedRecords: nonNegative(row.affected),
    examples: (row.examples ?? []).filter(value => /^[A-Za-z0-9._:-]{1,128}$/u.test(value)),
  }));
}

async function mailMetrics(pool: Pool, checkedAt: string) {
  const result = await pool.query<{
    sent: number | string;
    failed: number | string;
    pending: number | string;
    overdue: number | string;
    last_failure_at: Date | string | null;
    last_success_at: Date | string | null;
    last_error_code: string | null;
  }>(
    `select
       count(*) filter (where status = 'sent' and sent_at >= $1::timestamptz - interval '30 days' and sent_at <= $1::timestamptz) as sent,
       count(*) filter (where status in ('pending','failed','sending')) as pending,
       count(*) filter (where (status in ('pending','failed') and next_attempt_at < $1::timestamptz - interval '5 minutes')
         or (status = 'sending' and lease_expires_at < $1::timestamptz)) as overdue,
       max(updated_at) filter (where last_error_code is not null and last_error_code <> 'token_superseded' and status in ('failed','cancelled')) as last_failure_at,
       count(*) filter (where status = 'failed' and updated_at >= $1::timestamptz - interval '24 hours' and updated_at <= $1::timestamptz) as failed,
       max(sent_at) filter (where status = 'sent') as last_success_at,
       (array_agg(last_error_code order by updated_at desc)
         filter (where status = 'failed' and last_error_code is not null))[1] as last_error_code
     from (select status, sent_at, updated_at, last_error_code, next_attempt_at, lease_expires_at from password_reset_outbox
       union all select status, sent_at, updated_at, last_error_code, next_attempt_at, lease_expires_at from email_change_outbox) mail_outbox`,
    [checkedAt],
  );
  const row = result.rows[0];
  return {
    sent: nonNegative(row?.sent),
    pending: nonNegative(row?.pending),
    overdue: nonNegative(row?.overdue),
    lastFailureAt: nullableIso(row?.last_failure_at),
    failed: nonNegative(row?.failed),
    lastSuccessAt: nullableIso(row?.last_success_at),
    lastErrorCode: row?.last_error_code ? safeCode(row.last_error_code, "mail_delivery_failed") : null,
  };
}

function queueByName(queues: readonly AdminQueueSnapshot[], name: string) {
  return queues.find((queue) => queue.name === name) ?? null;
}

function queueState(queues: readonly AdminQueueSnapshot[], names: readonly string[]): AdminDiagnosticState {
  const selected = names.map((name) => queueByName(queues, name));
  if (selected.some(queue => queue?.state === "down")) return "down";
  if (selected.some(queue => queue?.state === "degraded")) return "degraded";
  if (selected.some(queue => !queue || queue.state === "unavailable")) return "unavailable";
  if (selected.every(queue => queue?.state === "not_configured")) return "not_configured";
  if (selected.some(queue => queue?.state === "stale")) return "stale";
  if (selected.length > 0 && selected.every(queue => queue?.state === "healthy")) return "healthy";
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
  "background_workers",
  "social_connections",
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
  let schemaPromise: ReturnType<typeof probeDatabaseAndSchema> | null = null;
  const schema = () => schemaPromise ??= probeDatabaseAndSchema();

  return [
    {
      id: "web_api", group: "core", label: "HTTP-процесс", description: "Текущий процесс: event loop, память, uptime",
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
          scope: "Локальный сигнал процесса, обслужившего этот запрос. Не проверяет все API, другие реплики и пользовательские сценарии.",
          affectedSections: [],
        };
      },
    },
    {
      id: "postgresql", group: "core", label: "PostgreSQL", description: "Доступность и пул соединений",
      run: async () => {
        if (!process.env.DATABASE_URL) return { state: "not_configured", evidence: [{ label: "DATABASE_URL", value: "Не настроен" }] };
        const startedAt = now();
        const before = getDatabasePoolSnapshot();
        await pool().query("select 1 as ok");
        const latencyMs = Math.max(0, Math.round(now() - startedAt));
        const snapshot = getDatabasePoolSnapshot();
        const state: AdminDiagnosticState = before.waiting > 0 || snapshot.recentAcquireErrors > 0
          ? "degraded" : "healthy";
        return {
          state,
          evidence: [
            { label: "PING", value: `${latencyMs} мс`, tone: state === "healthy" ? "positive" : "warning" },
            { label: "Последний успешный запрос", value: new Date(now()).toISOString() },
          ],
          safeErrorCode: state === "degraded" ? "database_pool_pressure" : null,
          metrics: { latencyMs, ...snapshot, waitingBeforeProbe: before.waiting },
          scope: "SELECT 1 и пул текущего web-процесса. Ошибки соединения: последние 60 секунд отдельно от накопленных счётчиков; p95 — до 1024 последних замеров. Пулы других процессов здесь не суммируются.",
          affectedSections: [],
        };
      },
    },
    {
      id: "database_schema", group: "core", label: "Схема базы", description: "Версия, миграции и capabilities",
      run: async () => {
        const result = await schema();
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
        const failedQueues = queueSnapshots.filter((queue) => queue.state === "unavailable").length;
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
          scope: "PING подтверждает Redis. Память, uptime и подключения относятся ко всему Redis-серверу; очереди — только к выбранной logical DB. Отсутствие consumer не означает отказ Redis.",
          affectedSections: failedQueues > 0 ? ["calendar", "autopilot", "siteAnalysis", "analytics"] : [],
        };
      },
    },
    {
      id: "publication_worker", group: "core", label: "Воркер публикаций", description: "Heartbeat, очередь и подтверждённые публикации",
      run: async () => {
        const checkedAt = new Date(now()).toISOString();
        const [snapshot, queueSnapshots, metrics, history] = await Promise.all([redis(), queues(), publicationMetrics(pool(), checkedAt), publicationErrorHistory(pool(), checkedAt)]);
        if (!snapshot.configured) return { state: "not_configured", evidence: [{ label: "Redis", value: "Не настроен" }] };
        const parsed = parsePublicationHeartbeat(snapshot.publicationHeartbeatRaw, { nowMs: now() });
        const observedAt = parsed?.at ?? heartbeatAt(snapshot.publicationHeartbeatRaw);
        const heartbeatAgeMs = ageMs(observedAt, now());
        const publishQueue = queueByName(queueSnapshots, "publish");
        const state: AdminDiagnosticState = !parsed ? "down"
          : !publishQueue || publishQueue.state === "unavailable" ? "unavailable"
            : publishQueue.state === "down" ? "down"
              : metrics.overdue > 0 || metrics.stuck > 0 || metrics.failures > 0 || metrics.unverified > 0 || publishQueue.state === "degraded" ? "degraded"
                : publishQueue.workers === 0 ? "unobserved" : observationState(metrics.lastSuccessAt, now());
        return {
          state,
          evidence: [
            { label: "Heartbeat", value: observedAt, tone: parsed ? "positive" : "critical" },
            { label: "Возраст heartbeat", value: heartbeatAgeMs },
            { label: "Допустимый интервал", value: PUBLICATION_HEARTBEAT_TTL_SECONDS * 1_000 },
            { label: "Последняя успешная публикация", value: metrics.lastSuccessAt },
          ],
          safeErrorCode: !parsed ? "publication_heartbeat_stale" : metrics.stuck > 0 ? "publication_processing_stuck"
            : metrics.overdue > 0 ? "publication_schedule_overdue" : metrics.unverified > 0 ? "publication_delivery_unverified"
              : metrics.failures > 0 ? "publication_failed_records" : publishQueue?.safeErrorCode ?? null,
          lastSuccessAt: metrics.lastSuccessAt,
          history,
          validUntil: parsed ? new Date(Date.parse(parsed.at) + PUBLICATION_HEARTBEAT_TTL_SECONDS * 1000).toISOString() : undefined,
          scope: "Heartbeat подтверждает цикл обработчика. Исправность отправки требует успешной публикации за 15 минут. Счётчики постов: текущее состояние, published — за 24 часа. В posts нет времени последнего отказа; даты и частота ошибок доступны только для записанных событий. История — до 20 кодов за 24 часа, повторы считаются событиями; first/last ограничены этим окном.",
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
      id: "background_workers", group: "core", label: "Фоновые задачи", description: "Автопилот, статистика, планировщик и дополнительные очереди",
      run: async () => {
        const snapshots = await queues();
        const names = ["stats", "autopilot-plans", "site-articles", "project-export", "publication-extra", "monthly-campaign-regeneration", "publication-review-reminder", "cron"];
        const selected = snapshots.filter(queue => names.includes(queue.name));
        return { state: queueState(snapshots, names),
          evidence: [{ label: "Ожидаемые очереди", value: names.length },
            { label: "Расписания cron", value: `${queueByName(snapshots, "cron")?.schedulers ?? "—"} / ${CRON_SCHEDULES.length}` }],
          queues: selected, safeErrorCode: selected.find(queue => queue.safeErrorCode)?.safeErrorCode ?? null,
          scope: "Все перечисленные очереди полного worker проверяются независимо. Наличие и параметры cron сверяются с кодом регистрации; работа обработчиков требует выполнения за 15 минут. Доставка внешним сервисам оценивается отдельно.",
          affectedSections: ["autopilot", "analytics", "rss", "today"],
        };
      },
    },
    {
      id: "social_connections", group: "integrations", label: "Подключения соцсетей", description: "Сохранённые права каналов и срок OAuth-токенов",
      run: async () => {
        const result = await pool().query<{ connected: string; attention: string; expired: string; last_error_at: Date | null }>(
          `select count(*) filter (where c.is_active) as connected,
             count(*) filter (where c.is_active and c.status <> 'active') as attention,
             count(*) filter (where c.is_active and t.expires_at <= $1::timestamptz) as expired,
             max(c.last_auth_error_at) as last_error_at
           from channels c left join oauth_tokens t on t.id = c.oauth_token_id`, [new Date(now()).toISOString()],
        );
        const row = result.rows[0];
        const connected = nonNegative(row?.connected), attention = nonNegative(row?.attention), expired = nonNegative(row?.expired);
        return { state: !connected ? "not_used" : attention || expired ? "degraded" : "unobserved",
          evidence: [{ label: "Подключённые каналы", value: connected }, { label: "Требуют восстановления прав", value: attention }, { label: "Истёк access token", value: expired }],
          metrics: { lastFailureAt: nullableIso(row?.last_error_at) },
          safeErrorCode: attention ? "channel_access_attention" : expired ? "oauth_access_token_expired" : null,
          scope: "Сохранённые состояния, без вызова внешних API. Истёкший access token может обновляться через refresh token; возможность обновления, права и лимиты провайдера требуют отдельной проверки. Отсутствие каналов означает, что интеграция не используется.",
          links: [{ label: "Открыть подключения", href: "/admin#connections" }], affectedSections: ["settings", "calendar"],
        };
      },
    },
    {
      id: "telegram_worker", group: "integrations", label: "Telegram-воркер", description: "Polling heartbeat и конфликт владельца",
      run: async () => {
        if (!String(process.env.TG_BOT_TOKEN || "").trim()) {
          return { state: "not_used", evidence: [{ label: "Telegram", value: "Бот не подключён; polling не используется" }] };
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
          validUntil: parsed ? new Date(Date.parse(parsed.at) + TELEGRAM_POLLING_HEARTBEAT_TTL_SECONDS * 1000).toISOString() : undefined,
          scope: "Подтверждён цикл getUpdates этого бота. Отправка публикаций и права отдельных каналов проверяются отдельно.",
          affectedSections: ["settings"],
        };
      },
    },
    {
      id: "aurora_ai", group: "integrations", label: "Aurora AI", description: "Провайдеры, circuit state и использование",
      run: async () => {
        if (!probeAiConfiguration()) return { state: "not_configured", evidence: [{ label: "Провайдеры", value: "Не настроены" }] };
        const providers = aiProviderHealthSnapshot(now());
        const checkedAt = new Date(now()).toISOString();
        const usageResult = await pool().query<{
          provider: string; model: string; successes: string; failures: string;
          recent_successes: string; recent_failures: string; average_latency_ms: string | null;
          last_success_at: Date | string | null; last_failure_at: Date | string | null;
          first_failure_at: Date | string | null; last_error_code: string | null;
        }>(
          `select provider, model,
             count(*) filter (where outcome = 'succeeded') as successes,
             count(*) filter (where outcome = 'failed') as failures,
             count(*) filter (where outcome = 'succeeded' and created_at >= $1::timestamptz - interval '15 minutes') as recent_successes,
             count(*) filter (where outcome = 'failed' and created_at >= $1::timestamptz - interval '15 minutes') as recent_failures,
             avg(latency_ms) filter (where outcome in ('succeeded','failed')) as average_latency_ms,
             max(created_at) filter (where outcome = 'succeeded') as last_success_at,
             max(created_at) filter (where outcome = 'failed') as last_failure_at,
             min(created_at) filter (where outcome = 'failed') as first_failure_at,
             (array_agg(safe_error_code order by created_at desc, id desc) filter (where outcome = 'failed'))[1] as last_error_code
           from ai_provider_attempts
           where created_at >= $1::timestamptz - interval '30 days' and created_at <= $1::timestamptz
           group by provider, model order by provider, model`, [checkedAt],
        );
        const usage = await pool().query<{ today: string; period: string; timezone: string }>(
          `select count(*) filter (where status = 'committed' and usage_date = current_date) as today,
             count(*) filter (where status = 'committed' and created_at >= $1::timestamptz - interval '30 days' and created_at <= $1::timestamptz) as period,
             current_setting('TimeZone') as timezone from ai_usage`, [checkedAt],
        );
        const activeModels = usageResult.rows.map(row => {
          const lastSuccessAt = nullableIso(row.last_success_at);
          const lastFailureAt = nullableIso(row.last_failure_at);
          const unresolvedFailure = lastFailureAt !== null && now() - Date.parse(lastFailureAt) < EXECUTION_MAX_AGE_MS
            && (!lastSuccessAt || lastFailureAt >= lastSuccessAt);
          return {
            provider: row.provider, model: row.model,
            successes: nonNegative(row.successes), failures: nonNegative(row.failures),
            recentSuccesses: nonNegative(row.recent_successes), recentFailures: nonNegative(row.recent_failures),
            averageLatencyMs: row.average_latency_ms === null ? null : nonNegative(row.average_latency_ms),
            lastSuccessAt, lastFailureAt, firstFailureAt: nullableIso(row.first_failure_at),
            lastErrorCode: row.last_error_code ? safeCode(row.last_error_code, "provider_error") : null,
            state: unresolvedFailure ? "degraded" : observationState(lastSuccessAt, now()),
          };
        });
        const latestSuccess = activeModels.map(row => row.lastSuccessAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
        const recentSuccesses = activeModels.reduce((sum, row) => sum + row.recentSuccesses, 0);
        const recentFailures = activeModels.reduce((sum, row) => sum + row.recentFailures, 0);
        const unresolved = activeModels.find(row => row.state === "degraded");
        const openCircuit = providers.find(provider => (provider.state === "open" || provider.state === "half_open")
          && provider.updatedAt && now() - Date.parse(provider.updatedAt) < EXECUTION_MAX_AGE_MS);
        const failedProbe = providers.find(provider => provider.lastOutcome === "failure" && provider.updatedAt
          && now() - Date.parse(provider.updatedAt) < EXECUTION_MAX_AGE_MS
          && !activeModels.some(model => model.provider === provider.engine && model.lastSuccessAt
            && Date.parse(model.lastSuccessAt) > Date.parse(provider.updatedAt!)));
        const state: AdminDiagnosticState = unresolved || openCircuit || failedProbe ? "degraded" : observationState(latestSuccess, now());
        return {
          state,
          evidence: [
            { label: "Наблюдаемые маршруты за 30 дней", value: activeModels.length },
            { label: "Попытки за 15 минут", value: `${recentSuccesses} успешных · ${recentFailures} с ошибкой` },
            { label: "Последний успешный ответ", value: latestSuccess },
          ],
          safeErrorCode: unresolved?.lastErrorCode ?? (unresolved ? "ai_recent_failures" : failedProbe
            ? safeCode(failedProbe.lastFailureCode, "ai_probe_failed") : openCircuit ? "ai_circuit_unconfirmed" : null),
          lastSuccessAt: latestSuccess,
          scope: "Сохранённые попытки web и worker: 30 дней; текущее здоровье — последнее выполнение за 15 минут. Retry и fallback считаются отдельными попытками. Circuit — только этот web-процесс, без объединения реплик. Прямой вызов внешнего AI при просмотре не выполняется.",
          metrics: {
            recentSuccesses, recentFailures, providers, activeModels,
            usageToday: nonNegative(usage.rows[0]?.today), usagePeriod: nonNegative(usage.rows[0]?.period),
            usageTimezone: usage.rows[0]?.timezone ?? null,
          },
          affectedSections: ["studio", "autopilot", "knowledge", "opportunities", "siteAnalysis"],
        };
      },
    },
    {
      id: "media_generation", group: "integrations", label: "Обработка медиа", description: "Выполнение очередей генерации и рендера",
      run: async () => {
        const queueSnapshots = await queues();
        const selected = ["media-generation", "legal-visual-render"].map((name) => queueByName(queueSnapshots, name)).filter(Boolean) as AdminQueueSnapshot[];
        return {
          state: queueState(queueSnapshots, ["media-generation", "legal-visual-render"]),
          evidence: [{ label: "Очереди", value: selected.length }],
          scope: "Обе очереди должны подтвердить выполнение за 15 минут. BullMQ completed подтверждает завершение обработчика; качество результата внешнего media API здесь не проверяется.",
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
        const result = await pool().query<{ running: number | string; failed: number | string; last_failure_at: Date | string | null; last_success_at: Date | string | null }>(
          `select count(*) filter (where status in ('queued','running')) as running,
                  count(*) filter (where status = 'failed' and updated_at >= $1::timestamptz - interval '24 hours' and updated_at <= $1::timestamptz) as failed,
                  max(updated_at) filter (where status = 'failed') as last_failure_at,
                  max(completed_at) filter (where status = 'ready') as last_success_at
             from site_analysis_jobs`, [new Date(now()).toISOString()],
        );
        const row = result.rows[0];
        const failed = nonNegative(row?.failed);
        const base = queueState(queueSnapshots, ["site-analysis"]);
        const lastSuccessAt = nullableIso(row?.last_success_at);
        const lastFailureAt = nullableIso(row?.last_failure_at);
        const recentFailure = lastFailureAt && now() - Date.parse(lastFailureAt) < EXECUTION_MAX_AGE_MS
          && (!lastSuccessAt || lastFailureAt >= lastSuccessAt);
        const state: AdminDiagnosticState = base === "down" || base === "unavailable" ? base
          : recentFailure || base === "degraded" ? "degraded"
            : selected?.workers ? observationState(lastSuccessAt, now()) : base;
        return {
          state,
          evidence: [{ label: "Последний готовый отчёт", value: nullableIso(row?.last_success_at) }],
          safeErrorCode: recentFailure ? "site_analysis_recent_failures" : selected?.safeErrorCode ?? null,
          scope: "Готовность отчёта подтверждается доменной записью за 15 минут. Failed — записи в текущем состоянии failed, обновлённые за 24 часа; история после восстановления остаётся в счётчике.",
          lastSuccessAt: nullableIso(row?.last_success_at),
          metrics: { running: nonNegative(row?.running), failed, lastFailureAt },
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
        const metrics = await mailMetrics(pool(), new Date(now()).toISOString());
        const recentFailure = metrics.lastFailureAt && now() - Date.parse(metrics.lastFailureAt) < EXECUTION_MAX_AGE_MS
          && (!metrics.lastSuccessAt || metrics.lastFailureAt >= metrics.lastSuccessAt);
        const state: AdminDiagnosticState = metrics.overdue > 0 || recentFailure ? "degraded" : observationState(metrics.lastSuccessAt, now());
        return {
          state,
          evidence: [{ label: "Последнее принятие почтовым API", value: metrics.lastSuccessAt }],
          safeErrorCode: metrics.overdue > 0 ? "mail_outbox_overdue" : recentFailure ? metrics.lastErrorCode ?? "mail_recent_failure" : null,
          scope: "Сброс пароля и смена email. Sent означает принятие почтовым API, доставка в ящик не измеряется. Отправлено — 30 дней, failed — текущее состояние с обновлением за 24 часа. Свежесть успеха — 15 минут.",
          lastSuccessAt: metrics.lastSuccessAt,
          metrics,
          affectedSections: ["settings"],
        };
      },
    },
    {
      id: "token_encryption", group: "security", label: "Шифрование токенов", description: "Keyring и известные envelope key IDs",
      run: async () => {
        const result = await schema();
        const state: AdminDiagnosticState = result.database !== "up" || !result.schema.ready ? "unavailable" : result.tokenEncryption === "up" ? "configured"
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
        let origin: URL;
        try { origin = new URL(value); } catch { return { state: "down", evidence: [{ label: "APP_URL", value: "Некорректен" }], safeErrorCode: "app_origin_invalid" }; }
        const protocol = origin.protocol;
        const secure = protocol === "https:";
        const loopbackHttp = protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
          && process.env.AURORA_ENVIRONMENT !== "production";
        const state: AdminDiagnosticState = secure || loopbackHttp ? "configured" : "down";
        return {
          state,
          evidence: [{ label: "Протокол", value: protocol.replace(":", "") }],
          safeErrorCode: secure || loopbackHttp ? null : "app_origin_not_https",
          scope: loopbackHttp ? "HTTP допустим для локального loopback. TLS и production ingress этой проверкой не подтверждены." : "Проверяется конфигурация origin; сертификат и доступность внешнего ingress требуют отдельной проверки.",
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
          state: complete ? "configured" : "unobserved",
          evidence: [
            { label: "Версия", value: release.release },
            { label: "Commit", value: release.commitSha },
            { label: "Развёрнут", value: release.deployedAt },
          ],
          safeErrorCode: complete ? null : "release_metadata_incomplete",
          scope: "Метаданные релиза; наличие переменных не подтверждает соответствие запущенных файлов commit.",
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
  const unused = components.filter(component => component.state === "not_used").length;
  const warnings = components.length - healthy - configured - critical - unused;
  const coreCritical = components.some((component) => component.group === "core" && (component.state === "down" || component.state === "conflict"));
  const state: AdminDiagnosticState = coreCritical ? "down" : critical > 0 || components.some(c => c.state === "degraded") ? "degraded"
    : components.length === 0 || warnings > 0 || configured > 0 || healthy === 0 ? "unobserved" : "healthy";
  return {
    schemaVersion: 1,
    checkedAt: new Date(now()).toISOString(),
    durationMs: Math.max(0, Math.round(now() - startedAt)),
    state,
    summary: { total: components.length, healthy, configured, warnings, critical },
    release: auroraReleaseMetadata(),
    environment: diagnosticEnvironment(),
    runtimeMode: process.env.NODE_ENV ?? "unknown",
    components,
  };
}

function diagnosticEnvironment(): "local" | "staging" | "production" | "unknown" {
  try {
    if (["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.APP_URL || "").hostname)) return "local";
  } catch { /* Missing origin does not establish a deployment environment. */ }
  const environment = process.env.AURORA_ENVIRONMENT;
  return environment === "staging" || environment === "production" ? environment : "unknown";
}
