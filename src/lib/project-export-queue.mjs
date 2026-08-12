import { Queue } from "bullmq";

export const PROJECT_EXPORT_QUEUE = "project-export";

const globalQueue = globalThis;

function producerConnectionOptions(value = process.env.REDIS_URL || "redis://127.0.0.1:6379") {
  const url = new URL(value);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") throw new Error("invalid_redis_protocol");
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

export class ProjectExportQueueUnavailableError extends Error {
  constructor() {
    super("project export queue operation did not complete safely");
    this.name = "ProjectExportQueueUnavailableError";
    this.code = "project_export_queue_unavailable";
  }
}

function getProjectExportQueue() {
  if (globalQueue.__auroraProjectExportQueue) return globalQueue.__auroraProjectExportQueue;
  const queue = new Queue(PROJECT_EXPORT_QUEUE, { connection: producerConnectionOptions() });
  globalQueue.__auroraProjectExportQueue = queue;
  return queue;
}

async function within(work, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ProjectExportQueueUnavailableError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function projectExportJobId(operationId) {
  const id = Number(operationId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("invalid_project_export_operation_id");
  return `project-export-${id}`;
}

/** Deterministic enqueue with ambiguous-ACK recovery. */
export async function enqueueProjectExportJob(data, queue = getProjectExportQueue(), timeoutMs = 2_000) {
  const operationId = Number(data?.operationId);
  const projectId = Number(data?.projectId);
  const snapshotHash = String(data?.snapshotHash ?? "");
  if (
    !Number.isSafeInteger(operationId) || operationId <= 0
    || !Number.isSafeInteger(projectId) || projectId <= 0
    || !/^[0-9a-f]{64}$/u.test(snapshotHash)
  ) throw new Error("invalid_project_export_job");
  const jobId = projectExportJobId(operationId);
  const payload = { operationId, projectId, snapshotHash };
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
      // The durable outbox keeps ownership when Redis cannot confirm either outcome.
    }
    throw new ProjectExportQueueUnavailableError();
  }
}

export async function hasProjectExportWorker(queue = getProjectExportQueue(), timeoutMs = 1_500) {
  try {
    return (await within(queue.getWorkersCount(), timeoutMs)) > 0;
  } catch {
    return false;
  }
}
