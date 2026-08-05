import type { QualityResult } from "./post-quality.mjs";

export const AUTOPILOT_FRESHNESS_MS: 60000;
export const AUTOPILOT_PREVIEW_TTL_MS: 300000;

export interface ApprovalBlocker {
  code: "expired" | "invalid_schedule" | "empty_draft" | "quality_missing" | "quality_failed" | "semantic_review_required";
  message: string;
}

export interface AutopilotApprovalItem {
  i: number;
  scheduledAt: string;
  topic?: string;
  draft?: string;
  status: string;
  postId?: number;
  qualityBlocked?: boolean;
  invented?: string[];
  quality?: QualityResult;
  approvalBlockers?: ApprovalBlocker[];
}

export interface AutopilotApprovalEvaluation {
  actionable: boolean;
  eligible: boolean;
  scheduledAt: string | null;
  blockers: ApprovalBlocker[];
}

export interface AutopilotApprovalPreview {
  /** Present only on a persisted server preview returned to a caller. */
  token?: string;
  planId: number;
  revision: number;
  hash: string;
  channel: { id: number; title: string | null; handle: string | null };
  counts: { total: number; eligible: number; expired: number; blocked: number };
  dates: Array<{ index: number; scheduledAt: string | null }>;
  blockers: Array<{
    index: number;
    topic: string;
    scheduledAt: string | null;
    reasons: ApprovalBlocker[];
  }>;
  items: Array<Record<string, unknown>>;
  generatedAt: string;
  expiresAt: string;
  requiresConfirmation: boolean;
}

export function createAutopilotPreviewToken(bytes?: number): string;
export function hashAutopilotPreviewToken(token: string): string;
export function autopilotPlanRevisionHash(input: {
  items: AutopilotApprovalItem[];
  planId: number;
  planRevision: number;
  channelId: number;
}): string;

export function evaluateAutopilotItem(
  item: AutopilotApprovalItem,
  nowMs?: number,
): AutopilotApprovalEvaluation;
export function annotateAutopilotItems<T extends AutopilotApprovalItem>(items: T[], nowMs?: number): T[];
export function buildAutopilotApprovalPreview(input: {
  items: AutopilotApprovalItem[];
  nowMs?: number;
  channel: { id: number; title?: string | null; handle?: string | null };
  planId: number;
  planRevision?: number;
  expiresAtMs?: number;
}): AutopilotApprovalPreview;
export function executeAutopilotApproval<T extends AutopilotApprovalItem>(input: {
  items: T[];
  nowMs?: number;
  schedule: (item: T, scheduledAt: string) => Promise<number>;
  onCheckpoint?: (items: T[], item: T, scheduled: number) => Promise<void> | void;
}): Promise<{ items: T[]; scheduled: number; error: unknown | null }>;
