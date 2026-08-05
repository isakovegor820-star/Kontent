export const AUTOPILOT_APPROVAL_LEASE_SECONDS: number;

export interface AutopilotQueryResult<Row = Record<string, unknown>> {
  rows?: Row[];
  rowCount?: number | null;
}

export interface AutopilotQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<AutopilotQueryResult>;
}

export interface AutopilotPoolClient extends AutopilotQueryable {
  release(): void;
}

export interface AutopilotPool extends AutopilotQueryable {
  connect(): Promise<AutopilotPoolClient>;
}

export class AutopilotApprovalLeaseLostError extends Error {
  code: "AUTOPILOT_APPROVAL_LEASE_LOST";
}

export class AutopilotScheduleBlockedError extends Error {
  code: "AUTOPILOT_ITEM_BLOCKED";
  blockers: Array<{ code: string; message: string }>;
}

export function autopilotItemOperationKey(planId: number, index: number): string;
export function resolvedAutopilotPlanStatus(items: unknown[]): "pending" | "approved";
export function reclaimStaleAutopilotApprovals(
  db: AutopilotQueryable,
  input?: { userId?: number | null; channelId?: number | null; leaseSeconds?: number },
): Promise<unknown[]>;
export function claimAutopilotPlan(
  db: AutopilotQueryable,
  input: {
    planId: number;
    userId: number;
    channelId: number;
    operationId: number;
    allowedStatuses?: string[];
    expectedRevision?: number | null;
  },
): Promise<Record<string, unknown> | null>;
export function scheduleAutopilotItem(input: {
  pool: AutopilotPool;
  enqueue: (postId: number, scheduledAt: string, scheduleRevision?: number) => Promise<unknown>;
  planId: number;
  userId: number;
  channelId: number;
  operationId: number;
  index: number;
  nowMs?: number;
}): Promise<{
  postId: number;
  scheduledAt: string;
  items: Array<Record<string, unknown>>;
  replayed: boolean;
  queuePending: boolean;
  queueError: unknown;
}>;
export function finalizeAutopilotApproval(input: {
  pool: AutopilotPool;
  planId: number;
  userId: number;
  channelId: number;
  operationId: number;
  items: unknown[];
  planStatus?: "pending" | "approved";
  operationStatus: "completed" | "partial" | "failed";
  result: unknown;
  httpStatus: number;
  streakEligible?: boolean | null;
  edited?: boolean;
}): Promise<boolean>;
export function abortAutopilotApproval(input: {
  pool: AutopilotPool;
  planId: number;
  userId: number;
  channelId: number;
  operationId: number;
  result: unknown;
  httpStatus?: number;
}): Promise<boolean>;
export function reconcileAutopilotScheduleOutbox(input: {
  pool: AutopilotPool;
  enqueue: (postId: number, scheduledAt: string, scheduleRevision?: number) => Promise<unknown>;
  limit?: number;
}): Promise<{ scanned: number; enqueued: number; pending: number }>;
