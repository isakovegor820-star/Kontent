import { Queue } from "bullmq";

export const LEGAL_VISUAL_RENDER_QUEUE = "legal-visual-render";

const globalQueue = globalThis;

function producerConnectionOptions(value = process.env.REDIS_URL || "redis://127.0.0.1:6379") {
  const url = new URL(value);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("invalid_redis_protocol");
  }
  const databaseText = url.pathname.replace(/^\/+|\/+$/gu, "");
  if (databaseText && !/^\d+$/u.test(databaseText)) throw new Error("invalid_redis_database");
  const db = databaseText ? Number(databaseText) : 0;
  if (!Number.isSafeInteger(db) || db < 0) throw new Error("invalid_redis_database");
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db,
    tls: url.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: 1,
    connectTimeout: 1_500,
    commandTimeout: 2_000,
    enableOfflineQueue: false,
  };
}

export class LegalVisualRenderQueueUnavailableError extends Error {
  constructor() {
    super("legal visual render queue operation did not complete safely");
    this.name = "LegalVisualRenderQueueUnavailableError";
    this.code = "legal_visual_render_queue_unavailable";
  }
}

async function within(work, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new LegalVisualRenderQueueUnavailableError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function getLegalVisualRenderQueue() {
  if (globalQueue.__auroraLegalVisualRenderQueue) return globalQueue.__auroraLegalVisualRenderQueue;
  const queue = new Queue(LEGAL_VISUAL_RENDER_QUEUE, { connection: producerConnectionOptions() });
  globalQueue.__auroraLegalVisualRenderQueue = queue;
  return queue;
}

export function legalVisualRenderJobId(operationId) {
  const id = Number(operationId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("invalid_legal_visual_render_operation_id");
  return `legal-visual-render-${id}`;
}

export async function enqueueLegalVisualRenderJob(
  data,
  queue = getLegalVisualRenderQueue(),
  timeoutMs = 2_000,
) {
  const operationId = Number(data?.operationId);
  const projectId = Number(data?.projectId);
  const configHash = String(data?.configHash ?? "");
  if (
    !Number.isSafeInteger(operationId) || operationId <= 0
    || !Number.isSafeInteger(projectId) || projectId <= 0
    || !/^[0-9a-f]{64}$/u.test(configHash)
  ) throw new Error("invalid_legal_visual_render_job");
  const jobId = legalVisualRenderJobId(operationId);
  const payload = { operationId, projectId, configHash };
  try {
    await within(queue.add("render", payload, {
      jobId,
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: 100,
      removeOnFail: 200,
    }), timeoutMs);
    return { jobId, recovered: false };
  } catch {
    try {
      if (await within(queue.getJob(jobId), timeoutMs)) return { jobId, recovered: true };
    } catch {
      // Durable outbox retains ownership until Redis can confirm the job.
    }
    throw new LegalVisualRenderQueueUnavailableError();
  }
}

export async function hasLegalVisualRenderWorker(
  queue = getLegalVisualRenderQueue(),
  timeoutMs = 1_500,
) {
  try {
    return (await within(queue.getWorkersCount(), timeoutMs)) > 0;
  } catch {
    return false;
  }
}
