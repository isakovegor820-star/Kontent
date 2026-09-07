import type { QueueWorkerProbe } from "./queue-worker-availability.mjs";
export const PROJECT_EXPORT_QUEUE: "project-export";
export class ProjectExportQueueUnavailableError extends Error {
  readonly code: "project_export_queue_unavailable";
}
export type ProjectExportJobData = Readonly<{
  operationId: number;
  projectId: number;
  snapshotHash: string;
}>;
export function projectExportJobId(operationId: number | string): string;
export function enqueueProjectExportJob(
  data: ProjectExportJobData,
  queue?: {
    add(name: string, data: ProjectExportJobData, options: Record<string, unknown>): Promise<unknown>;
    getJob(id: string): Promise<unknown>;
  },
  timeoutMs?: number,
): Promise<{ jobId: string; recovered: boolean }>;
export function hasProjectExportWorker(
  queue?: QueueWorkerProbe,
  timeoutMs?: number,
): Promise<boolean>;
