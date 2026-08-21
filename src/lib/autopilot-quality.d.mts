import type { PostQuality, QualityCheckTrigger, QualityResult } from "./post-quality.mjs";
import type { SemanticClaimAdapter } from "./semantic-claims.mjs";

export function autopilotQualityFailureKind(
  result: QualityResult | null | undefined,
): "passed" | "missing_evidence" | "semantic_unavailable" | "rewriteable";
export function autopilotQualityRepairStrategy(
  result: QualityResult | null | undefined,
): "deterministic_format" | "rewrite" | "add_knowledge" | "human_review"
  | "provider_retry" | "settings_change" | null;

export function padDraftToMinimum(
  text: string,
  minChars: number,
  maxChars: number,
  address?: PostQuality["address"],
): string;
export function trimDraftToMaximum(text: string, maxChars: number, minChars?: number): string;
export function fitAutopilotDraftLength(
  text: string,
  minChars: number,
  maxChars: number,
  address?: PostQuality["address"],
): string;
export function prepareAutopilotDraftForm(
  text: string,
  quality: Partial<PostQuality> | null | undefined,
): string;
export function autopilotOutputTokens(
  quality: { maxChars?: number; desiredMaxChars?: number } | null | undefined,
): number;

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
