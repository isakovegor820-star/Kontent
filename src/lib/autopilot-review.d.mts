import type { QualityResult } from "./post-quality.mjs";

export function isAutopilotHumanReviewItem(item: unknown): boolean;
export function reconcileAutopilotReviewQuality(quality: QualityResult): QualityResult;
export function attestAutopilotItemForHumanApproval<T extends Record<string, unknown>>(
  item: T,
  attestor?: { userId?: number; attestedAt?: string | number | Date },
): T;
