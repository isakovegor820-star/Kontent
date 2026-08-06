import type { Queue } from "bullmq";

import { getStatsQueue } from "./queue";

export type RadarSearchJobData = {
  runId: number;
  userId: number;
};

type RadarQueue = Pick<Queue, "add" | "getJob">;

export class RadarSearchQueueUnavailableError extends Error {
  readonly code = "radar_search_queue_unavailable";

  constructor() {
    super("radar search queue operation did not complete safely");
    this.name = "RadarSearchQueueUnavailableError";
  }
}

async function within<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RadarSearchQueueUnavailableError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function enqueueRadarSearch(
  data: RadarSearchJobData,
  queue: RadarQueue = getStatsQueue(),
  timeoutMs = 2_000,
): Promise<{ jobId: string; recovered: boolean }> {
  const jobId = `radar-search-${data.runId}`;
  try {
    await within(queue.add("radar-search", data, {
      jobId,
      attempts: 2,
      backoff: { type: "exponential", delay: 12_000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    }), timeoutMs);
    return { jobId, recovered: false };
  } catch {
    try {
      const accepted = await within(queue.getJob(jobId), timeoutMs);
      if (accepted) return { jobId, recovered: true };
    } catch {
      // Поздняя job безопасна: воркер атомарно заявляет только queued run.
    }
    throw new RadarSearchQueueUnavailableError();
  }
}

