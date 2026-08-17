import type { QualityResult } from "./post-quality.mjs";

export interface AutopilotPlanVisibilityItem {
  status?: string;
  qualityOrigin?: string;
  quality?: QualityResult;
}

export function autopilotPlanNeedsQualityRebuild(
  items: AutopilotPlanVisibilityItem[] | null | undefined,
): boolean;
