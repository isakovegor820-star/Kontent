import type { Pool } from "pg";

type MutationBase = {
  pool: Pool;
  userId: number;
  projectId: number;
  operationId: number;
  expectedRevision: number;
  expectedStatus?: string;
  idempotencyKey: string;
  requestId?: string | null;
};

export type PublicationMutationResult = {
  ok: boolean;
  error?: string;
  httpStatus?: number;
  operationId?: number;
  status?: string;
  operationStatus?: string;
  scheduleRevision?: number;
  previousRevision?: number;
  currentRevision?: number;
  currentStatus?: string;
  scheduledAt?: string;
  timezone?: string;
  offset?: string;
  disambiguation?: "reject" | "earlier" | "later";
  postIds?: number[];
  postId?: number;
  draftId?: number;
  draftVersion?: number;
  replayed?: boolean;
};

export function cancelPublicationOperation(input: MutationBase): Promise<PublicationMutationResult>;
export function reschedulePublicationOperation(
  input: MutationBase & {
    scheduledAt: string;
    timezone: string;
    offset: string;
    disambiguation: "reject" | "earlier" | "later";
  },
): Promise<PublicationMutationResult>;
export function restorePublicationDraft(input: MutationBase): Promise<PublicationMutationResult>;
