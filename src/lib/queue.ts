// Очередь публикации (Д.3). Сердце автопостинга: пост встаёт в очередь с задержкой
// «опубликовать в назначенную минуту», а отдельный воркер её исполняет — даже если
// пользователь закрыл ноутбук. Приложение (Next) только КЛАДЁТ задачи; исполняет worker.mjs.

import { Queue, type ConnectionOptions } from "bullmq";

export const PUBLISH_QUEUE = "publish";
export const STATS_QUEUE = "stats";
export const MEDIA_QUEUE = "media-generation";

const globalForQueue = globalThis as unknown as {
  auroraQueue?: Queue;
  auroraStatsQueue?: Queue;
  auroraMediaQueue?: Queue;
};

// Параметры Redis из URL. Передаём объектом (а не экземпляром ioredis), чтобы BullMQ
// сам создал соединение — так не конфликтуют версии ioredis.
function connection(): ConnectionOptions {
  const url = new URL(process.env.REDIS_URL || "redis://127.0.0.1:6379");
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    tls: url.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

export function getPublishQueue(): Queue {
  if (globalForQueue.auroraQueue) return globalForQueue.auroraQueue;
  const q = new Queue(PUBLISH_QUEUE, { connection: connection() });
  globalForQueue.auroraQueue = q;
  return q;
}

export function getStatsQueue(): Queue {
  if (globalForQueue.auroraStatsQueue) return globalForQueue.auroraStatsQueue;
  const q = new Queue(STATS_QUEUE, { connection: connection() });
  globalForQueue.auroraStatsQueue = q;
  return q;
}

export function getMediaQueue(): Queue {
  if (globalForQueue.auroraMediaQueue) return globalForQueue.auroraMediaQueue;
  const q = new Queue(MEDIA_QUEUE, { connection: connection() });
  globalForQueue.auroraMediaQueue = q;
  return q;
}

/** Детерминированный id задачи — по id поста. Позволяет отменить/пересоздать задачу.
 *  Без двоеточий — BullMQ их запрещает в custom id. */
export function jobIdForPost(postId: number | string): string {
  return `post-${postId}`;
}
