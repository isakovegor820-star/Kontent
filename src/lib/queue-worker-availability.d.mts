import type { Queue } from "bullmq";
export type QueueWorkerProbe = Pick<Queue, "client" | "getWorkers">;
export function countQueueWorkersForDatabase(queue: QueueWorkerProbe): Promise<number>;
export function hasQueueWorker(queue: QueueWorkerProbe, timeoutMs?: number): Promise<boolean>;
