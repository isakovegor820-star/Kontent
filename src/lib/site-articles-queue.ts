import { Queue } from "bullmq";

import { redisProducerConnectionOptions } from "./queue";

export const SITE_ARTICLES_QUEUE = "site-articles";
export type SiteArticleJobName = "plan" | "generate" | "publish" | "reconcile" | "probe" | "report";

const globalForQueue = globalThis as unknown as { auroraSiteArticlesQueue?: Queue };

export function getSiteArticlesQueue(): Queue {
  if (globalForQueue.auroraSiteArticlesQueue) return globalForQueue.auroraSiteArticlesQueue;
  const queue = new Queue(SITE_ARTICLES_QUEUE, { connection: redisProducerConnectionOptions() });
  globalForQueue.auroraSiteArticlesQueue = queue;
  return queue;
}

export class SiteArticlesQueueUnavailableError extends Error {
  readonly code = "site_articles_queue_unavailable";

  constructor() {
    super("site articles queue operation did not complete safely");
    this.name = "SiteArticlesQueueUnavailableError";
  }
}

async function within<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SiteArticlesQueueUnavailableError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function hasSiteArticlesWorker(queue: Pick<Queue, "getWorkersCount"> = getSiteArticlesQueue(), timeoutMs = 1_500): Promise<boolean> {
  try {
    return (await within(queue.getWorkersCount(), timeoutMs)) > 0;
  } catch {
    return false;
  }
}

/**
 * Идентичность job'а детерминирована: повторный клик «Опубликовать» или «Сгенерировать»
 * сходится в один job, а не порождает две параллельные попытки.
 */
export async function enqueueSiteArticleJob(
  name: SiteArticleJobName,
  data: Record<string, unknown>,
  options: { jobId?: string; delayMs?: number } = {},
  queue: Pick<Queue, "add"> = getSiteArticlesQueue(),
  timeoutMs = 2_000,
): Promise<{ jobId: string }> {
  const key = data.articleId ?? data.publicationId ?? data.siteId ?? "x";
  const suffix = options.jobId ?? `site-articles-${name}-${key}`;
  try {
    await within(queue.add(name, data, {
      jobId: suffix,
      delay: options.delayMs ?? 0,
      attempts: name === "publish" ? 1 : 2,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: 100,
      removeOnFail: 200,
    }), timeoutMs);
    return { jobId: suffix };
  } catch {
    throw new SiteArticlesQueueUnavailableError();
  }
}
