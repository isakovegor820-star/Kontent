import type { QualityResult } from "./post-quality.mjs";

export const AUTOPILOT_FRESHNESS_MS: 60000;
export const AUTOPILOT_PREVIEW_TTL_MS: 300000;

export interface ApprovalBlocker {
  code: "expired" | "invalid_schedule" | "empty_draft" | "quality_missing" | "quality_failed" | "semantic_review_required" | "editor_draft_linked";
  message: string;
}

export interface AutopilotApprovalItem {
  i: number;
  scheduledAt: string;
  topic?: string;
  draft?: string;
  status: string;
  postId?: number;
  draftId?: number;
  monthlyCampaignItemId?: number;
  qualityBlocked?: boolean;
  reviewRequired?: boolean;
  reviewState?: "semantic_only_review";
  invented?: string[];
  quality?: QualityResult;
  humanAttestation?: {
    kind: "human_review";
    reviewState: "semantic_only_review";
    userId: number;
    attestedAt: string;
    qualityCheckedAt: string;
  };
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
  expectedCount: number;
  complete: boolean;
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

export function isAutopilotHumanReviewItem(item: unknown): boolean;
export function hasServerAutopilotHumanAttestation(item: unknown): boolean;
export function attestAutopilotItemForHumanApproval<T extends AutopilotApprovalItem>(
  item: T,
  attestor?: { userId?: number; attestedAt?: string | number | Date },
): T;
export function evaluateAutopilotItem(
  item: AutopilotApprovalItem,
  nowMs?: number,
  options?: { actor?: "human" | "system" },
): AutopilotApprovalEvaluation;
export function annotateAutopilotItems<T extends AutopilotApprovalItem>(
  items: T[],
  nowMs?: number,
  options?: { actor?: "human" | "system" },
): T[];
export function buildAutopilotApprovalPreview(input: {
  items: AutopilotApprovalItem[];
  nowMs?: number;
  channel: { id: number; title?: string | null; handle?: string | null };
  planId: number;
  planRevision?: number;
  expectedCount?: number;
  expiresAtMs?: number;
  actor?: "human" | "system";
}): AutopilotApprovalPreview;
export function executeAutopilotApproval<T extends AutopilotApprovalItem>(input: {
  items: T[];
  nowMs?: number;
  schedule: (item: T, scheduledAt: string) => Promise<number>;
  onCheckpoint?: (items: T[], item: T, scheduled: number) => Promise<void> | void;
  attestor?: { userId: number; attestedAt?: string };
}): Promise<{ items: T[]; scheduled: number; error: unknown | null }>;
