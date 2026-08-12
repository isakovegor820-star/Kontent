export const PUBLICATION_EXTRA_QUEUE: "publication-extra";
export class PublicationExtraQueueUnavailableError extends Error {
  code: "publication_extra_queue_unavailable";
}
export function publicationExtraJobId(operationId: number, fingerprint: string): string;
export function enqueuePublicationExtraJob(
  data: { operationId: number; projectId: number; fingerprint: string },
  queue?: {
    add(name: string, data: unknown, options: unknown): Promise<unknown>;
    getJob(id: string): Promise<unknown>;
  },
  timeoutMs?: number,
): Promise<{ jobId: string; recovered: boolean }>;
