import { Queue } from "bullmq";

import { redisProducerConnectionOptions } from "./queue";

export const SITE_ANALYSIS_QUEUE = "site-analysis";

const globalForSiteAnalysisQueue = globalThis as unknown as {
  auroraSiteAnalysisQueue?: Queue;
};

export function getSiteAnalysisQueue(): Queue {
  if (globalForSiteAnalysisQueue.auroraSiteAnalysisQueue) {
    return globalForSiteAnalysisQueue.auroraSiteAnalysisQueue;
  }
  const queue = new Queue(SITE_ANALYSIS_QUEUE, { connection: redisProducerConnectionOptions() });
  globalForSiteAnalysisQueue.auroraSiteAnalysisQueue = queue;
  return queue;
}

export class SiteAnalysisQueueUnavailableError extends Error {
  readonly code = "site_analysis_queue_unavailable";

  constructor() {
    super("site analysis queue operation did not complete safely");
    this.name = "SiteAnalysisQueueUnavailableError";
  }
}

async function within<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SiteAnalysisQueueUnavailableError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type SiteAnalysisQueueProbe = Pick<Queue, "getWorkersCount">;

export async function hasSiteAnalysisWorker(
  queue: SiteAnalysisQueueProbe = getSiteAnalysisQueue(),
  timeoutMs = 1_500,
): Promise<boolean> {
  try {
    return (await within(queue.getWorkersCount(), timeoutMs)) > 0;
  } catch {
    return false;
  }
}

type SiteAnalysisQueueProducer = Pick<Queue, "add" | "getJob">;

export type SiteAnalysisJobData = {
  analysisId: number;
  requestId: string;
  runRevision: number;
};

export async function enqueueSiteAnalysis(
  data: SiteAnalysisJobData,
  queue: SiteAnalysisQueueProducer = getSiteAnalysisQueue(),
  timeoutMs = 2_000,
): Promise<{ recovered: boolean; jobId: string }> {
  const jobId = `site-analysis-${data.analysisId}-r${data.runRevision}`;
  try {
    await within(queue.add("analyze", data, {
      jobId,
      // Give the producer a short window to persist queue_confirmed_at. The worker still
      // treats an earlier delivery as retryable, so this is latency smoothing, not the
      // correctness boundary.
      delay: 1_000,
      attempts: 2,
      backoff: { type: "exponential", delay: 15_000 },
      removeOnComplete: 50,
      removeOnFail: 100,
    }), timeoutMs);
    return { recovered: false, jobId };
  } catch {
    try {
      const accepted = await within(queue.getJob(jobId), timeoutMs);
      if (accepted) return { recovered: true, jobId };
    } catch {
      // Caller terminalizes the still-unconfirmed row. Revision checks make a late job inert.
    }
    throw new SiteAnalysisQueueUnavailableError();
  }
}
