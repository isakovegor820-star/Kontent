import type { Queue } from "bullmq";

export const LEGAL_VISUAL_RENDER_QUEUE: "legal-visual-render";
export class LegalVisualRenderQueueUnavailableError extends Error {
  readonly code: "legal_visual_render_queue_unavailable";
}
export function getLegalVisualRenderQueue(): Queue;
export function legalVisualRenderJobId(operationId: number | string): string;
export function enqueueLegalVisualRenderJob(
  data: { operationId: number; projectId: number; configHash: string },
  queue?: Pick<Queue, "add" | "getJob">,
  timeoutMs?: number,
): Promise<{ jobId: string; recovered: boolean }>;
export function hasLegalVisualRenderWorker(
  queue?: Pick<Queue, "getWorkersCount">,
  timeoutMs?: number,
): Promise<boolean>;
