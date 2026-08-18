// Очередь публикации (Д.3). Сердце автопостинга: пост встаёт в очередь с задержкой
// «опубликовать в назначенную минуту», а отдельный воркер её исполняет — даже если
// пользователь закрыл ноутбук. Приложение (Next) только КЛАДЁТ задачи; исполняет worker.mjs.

import { Queue, type ConnectionOptions } from "bullmq";

export const PUBLISH_QUEUE = "publish";
export const STATS_QUEUE = "stats";
export const MEDIA_QUEUE = "media-generation";
export const AUTOPILOT_QUEUE = "autopilot-plans";

const globalForQueue = globalThis as unknown as {
  auroraQueue?: Queue;
  auroraStatsQueue?: Queue;
  auroraMediaQueue?: Queue;
  auroraAutopilotQueue?: Queue;
};

// Параметры Redis из URL. Передаём объектом (а не экземпляром ioredis), чтобы BullMQ
// сам создал соединение — так не конфликтуют версии ioredis. Номер logical DB обязателен:
// producer и worker должны слушать один и тот же изолированный namespace.
export function redisProducerConnectionOptions(
  value = process.env.REDIS_URL || "redis://127.0.0.1:6379",
): ConnectionOptions & { db: number } {
  const url = new URL(value);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("REDIS_URL must use redis:// or rediss://");
  }
  const databaseText = url.pathname.replace(/^\/+|\/+$/gu, "");
  if (databaseText && !/^\d+$/u.test(databaseText)) {
    throw new Error("REDIS_URL database must be a non-negative integer");
  }
  const db = databaseText ? Number(databaseText) : 0;
  if (!Number.isSafeInteger(db) || db < 0) {
    throw new Error("REDIS_URL database must be a non-negative integer");
  }
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db,
    tls: url.protocol === "rediss:" ? {} : undefined,
    // HTTP producers must fail within the request budget. Worker.mjs owns its separate
    // blocking connection with maxRetriesPerRequest=null.
    maxRetriesPerRequest: 1,
    connectTimeout: 1_500,
    commandTimeout: 2_000,
    enableOfflineQueue: false,
  };
}

export function getPublishQueue(): Queue {
  if (globalForQueue.auroraQueue) return globalForQueue.auroraQueue;
  const q = new Queue(PUBLISH_QUEUE, { connection: redisProducerConnectionOptions() });
  globalForQueue.auroraQueue = q;
  return q;
}

export function getStatsQueue(): Queue {
  if (globalForQueue.auroraStatsQueue) return globalForQueue.auroraStatsQueue;
  const q = new Queue(STATS_QUEUE, { connection: redisProducerConnectionOptions() });
  globalForQueue.auroraStatsQueue = q;
  return q;
}

export function getMediaQueue(): Queue {
  if (globalForQueue.auroraMediaQueue) return globalForQueue.auroraMediaQueue;
  const q = new Queue(MEDIA_QUEUE, { connection: redisProducerConnectionOptions() });
  globalForQueue.auroraMediaQueue = q;
  return q;
}

export function getAutopilotQueue(): Queue {
  if (globalForQueue.auroraAutopilotQueue) return globalForQueue.auroraAutopilotQueue;
  const q = new Queue(AUTOPILOT_QUEUE, { connection: redisProducerConnectionOptions() });
  globalForQueue.auroraAutopilotQueue = q;
  return q;
}

export class MediaQueueUnavailableError extends Error {
  readonly code = "media_queue_unavailable";

  constructor() {
    super("media queue operation did not complete safely");
    this.name = "MediaQueueUnavailableError";
  }
}

async function within<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new MediaQueueUnavailableError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type MediaQueueProbe = Pick<Queue, "getWorkersCount">;

export async function hasMediaWorker(
  queue: MediaQueueProbe = getMediaQueue(),
  timeoutMs = 1_500,
): Promise<boolean> {
  try {
    return (await within(queue.getWorkersCount(), timeoutMs)) > 0;
  } catch {
    return false;
  }
}

type MediaQueueProducer = Pick<Queue, "add" | "getJob">;

export interface MediaQueueJobData {
  generationId: number;
  projectId: number;
  requestId: string;
  requestKey: string;
  providerRequestKey: string;
}

/**
 * A deterministic job id makes add replay-safe. If Redis drops the ACK after accepting
 * the job, getJob recovers the accepted outcome. If even verification is ambiguous the
 * API fails the still-unconfirmed DB row; a late job then cannot pass the worker claim.
 */
export async function enqueueMediaGeneration(
  data: MediaQueueJobData,
  queue: MediaQueueProducer = getMediaQueue(),
  timeoutMs = 2_000,
): Promise<{ recovered: boolean; jobId: string }> {
  const jobId = `media-${data.generationId}`;
  if (!Number.isSafeInteger(data.projectId) || data.projectId <= 0) {
    throw new TypeError("media queue project is required");
  }
  try {
    await within(queue.add(
      "generate",
      data,
      {
        jobId,
        attempts: 3,
        backoff: { type: "exponential", delay: 10_000 },
        removeOnComplete: 50,
        removeOnFail: 100,
      },
    ), timeoutMs);
    return { recovered: false, jobId };
  } catch {
    try {
      const accepted = await within(queue.getJob(jobId), timeoutMs);
      if (accepted) return { recovered: true, jobId };
    } catch {
      // The caller terminalizes the unconfirmed row. A late deterministic job is safe.
    }
    throw new MediaQueueUnavailableError();
  }
}

/** Детерминированный id задачи — по id поста. Позволяет отменить/пересоздать задачу.
 *  Без двоеточий — BullMQ их запрещает в custom id. */
export function jobIdForPost(postId: number | string): string {
  return `post-${postId}`;
}

/** Revision-bound identity: a stale delayed job cannot authorize a newer schedule. */
export function jobIdForPostRevision(
  postId: number | string,
  scheduleRevision: number | string,
): string {
  return `${jobIdForPost(postId)}-r${scheduleRevision}`;
}
