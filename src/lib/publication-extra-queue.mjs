import { Queue } from "bullmq";

export const PUBLICATION_EXTRA_QUEUE = "publication-extra";

const globalQueue = globalThis;

function producerConnectionOptions(value = process.env.REDIS_URL || "redis://127.0.0.1:6379") {
  const url = new URL(value);
  if (!(url.protocol === "redis:" || url.protocol === "rediss:")) throw new Error("invalid_redis_protocol");
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
export class PublicationExtraQueueUnavailableError extends Error {
  constructor() {
    super("publication extra queue operation did not complete safely");
    this.name = "PublicationExtraQueueUnavailableError";
    this.code = "publication_extra_queue_unavailable";
  }
}

function getPublicationExtraQueue() {
  if (globalQueue.__auroraPublicationExtraQueue) return globalQueue.__auroraPublicationExtraQueue;
  const queue = new Queue(PUBLICATION_EXTRA_QUEUE, { connection: producerConnectionOptions() });
  globalQueue.__auroraPublicationExtraQueue = queue;
  return queue;
}

async function within(work, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new PublicationExtraQueueUnavailableError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function publicationExtraJobId(operationId, fingerprint) {
  const id = Number(operationId);
  const hash = String(fingerprint || "");
  if (!Number.isSafeInteger(id) || id <= 0 || !/^[0-9a-f]{64}$/u.test(hash)) {
    throw new Error("invalid_publication_extra_job_identity");
  }
  return `publication-extra-${id}-${hash.slice(0, 16)}`;
}

export async function enqueuePublicationExtraJob(
  data,
  queue = getPublicationExtraQueue(),
  timeoutMs = 2_000,
) {
  const operationId = Number(data?.operationId);
  const projectId = Number(data?.projectId);
  const fingerprint = String(data?.fingerprint || "");
  const jobId = publicationExtraJobId(operationId, fingerprint);
  const payload = { operationId, projectId, fingerprint };
  try {
    await within(queue.add("execute", payload, {
      jobId,
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: 200,
      removeOnFail: 500,
    }), timeoutMs);
    return { jobId, recovered: false };
  } catch {
    try {
      if (await within(queue.getJob(jobId), timeoutMs)) return { jobId, recovered: true };
    } catch {
      // Durable outbox still owns the operation when Redis cannot confirm either result.
    }
    throw new PublicationExtraQueueUnavailableError();
  }
}
