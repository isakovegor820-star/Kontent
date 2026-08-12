import { UnrecoverableError, Worker } from "bullmq";

import {
  processProjectExportOperation,
  ProjectExportOperationError,
} from "../src/lib/project-export-operation.mjs";
import { PROJECT_EXPORT_QUEUE } from "../src/lib/project-export-queue.mjs";

function validJobData(value) {
  const operationId = Number(value?.operationId);
  const projectId = Number(value?.projectId);
  const snapshotHash = String(value?.snapshotHash ?? "");
  if (
    !Number.isSafeInteger(operationId) || operationId <= 0
    || !Number.isSafeInteger(projectId) || projectId <= 0
    || !/^[0-9a-f]{64}$/u.test(snapshotHash)
  ) throw new UnrecoverableError("invalid_project_export_job");
  return { operationId, projectId, snapshotHash };
}

export function createProjectExportWorker({
  connection,
  pool,
  concurrency = 1,
  WorkerClass = Worker,
}) {
  const worker = new WorkerClass(
    PROJECT_EXPORT_QUEUE,
    async (job) => {
      const data = validJobData(job?.data);
      const attempts = Math.max(1, Number(job?.opts?.attempts) || 1);
      const finalAttempt = Number(job?.attemptsMade || 0) + 1 >= attempts;
      try {
        return await processProjectExportOperation({ pool, ...data, finalAttempt });
      } catch (error) {
        if (error instanceof ProjectExportOperationError && !error.retryable) {
          throw new UnrecoverableError(error.code);
        }
        throw error;
      }
    },
    { connection, concurrency: Math.max(1, Math.min(4, Number(concurrency) || 1)) },
  );
  worker.on?.("failed", (job, error) => {
    console.error("[project-export-worker] failed", {
      operationId: Number(job?.data?.operationId) || null,
      projectId: Number(job?.data?.projectId) || null,
      errorName: error instanceof Error ? error.name : "Error",
    });
  });
  return worker;
}
