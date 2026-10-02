import type { Queue } from "bullmq";

import { getStatsQueue } from "./queue";

export type WebResearchJobData = {
  runId: number;
  userId: number;
  projectId: number;
  channelId: number;
};

type ResearchQueue = Pick<Queue, "add" | "getJob">;

export class WebResearchQueueUnavailableError extends Error {
  readonly code = "web_research_queue_unavailable";

  constructor() {
    super("web research queue operation did not complete safely");
    this.name = "WebResearchQueueUnavailableError";
  }
}

async function within<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new WebResearchQueueUnavailableError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Ставит исследование интернета в очередь воркера.
 *
 * Идемпотентность по `runId`: планировщик создаёт строку запуска заранее, поэтому
 * повторный клик пользователя или повторный cron не порождают второй выход в сеть.
 */
export async function enqueueWebResearch(
  data: WebResearchJobData,
  queue: ResearchQueue = getStatsQueue(),
  timeoutMs = 2_000,
): Promise<{ jobId: string; recovered: boolean }> {
  const jobId = `web-research-${data.runId}`;
  try {
    await within(queue.add("web-research", data, {
      jobId,
      attempts: 2,
      backoff: { type: "exponential", delay: 12_000 },
      removeOnComplete: 200,
      removeOnFail: 200,
    }), timeoutMs);
    return { jobId, recovered: false };
  } catch {
    try {
      const accepted = await within(queue.getJob(jobId), timeoutMs);
      if (accepted) return { jobId, recovered: true };
    } catch {
      // Поздняя job безопасна: воркер атомарно заявляет только запущенный run.
    }
    throw new WebResearchQueueUnavailableError();
  }
}
