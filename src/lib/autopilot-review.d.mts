import type { QualityResult } from "./post-quality.mjs";

export function isAutopilotHumanReviewItem(item: Record<string, unknown> | null | undefined): boolean;
export function reconcileAutopilotReviewQuality(quality: QualityResult): QualityResult;
export function attestAutopilotItemForHumanApproval<T extends Record<string, unknown>>(
  item: T,
  attestor?: { userId?: number; attestedAt?: string | number | Date },
): T;
