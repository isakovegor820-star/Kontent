import type { PostQuality, QualityCheckTrigger, QualityResult } from "./post-quality.mjs";
import type { SemanticClaimAdapter } from "./semantic-claims.mjs";

export function autopilotQualityFailureKind(
  result: QualityResult | null | undefined,
): "passed" | "missing_evidence" | "semantic_unavailable" | "rewriteable";

export function padDraftToMinimum(text: string, minChars: number, maxChars: number): string;
export function trimDraftToMaximum(text: string, maxChars: number): string;

export function removeUnverifiedSemanticClaims(
  text: string,
  semantic: {
    claimVerdicts?: Array<{ claim?: string; verdict?: string }>;
  } | null | undefined,
): string;

export function assessAutopilotDraft(input: {
  text: string;
  quality: PostQuality | unknown;
  topic?: string;
  sources: Array<{ id: string | number; text: string }>;
  citedShare?: number | null;
  invented?: string[];
  trigger?: QualityCheckTrigger;
  semanticAdapter?: SemanticClaimAdapter | null;
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<QualityResult>;
