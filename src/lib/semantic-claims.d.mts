export interface SemanticClaimAdapter {
  readonly id: string;
  readonly model?: string;
  check(
    input: {
      claims: Array<{ id: string; text: string }>;
      evidence: Array<{ id: string; text: string; start: number; end: number }>;
    },
    options?: { signal?: AbortSignal },
  ): Promise<{
    verdicts: Array<{
      claimId: string;
      verdict: "supported" | "unsupported" | "unknown" | "non_factual";
      evidenceIds?: string[];
      reasonCode?: string;
    }>;
  }>;
}

export interface SemanticPublicationResult {
  version: 1;
  status: "passed" | "blocked" | "not_checked";
  passed: boolean;
  requiresReview: boolean;
  blockers: Array<{ code: "unsupported_semantic_claim"; claimId: string; message: string }>;
  claimVerdicts: Array<{
    claimId: string;
    claim: string;
    verdict: "supported" | "unsupported" | "unknown" | "non_factual";
    reasonCode: string;
    riskCodes: string[];
    sourceSpans: Array<{ sourceId: string; start: number; end: number }>;
  }>;
  provenance: {
    validatorVersion: "semantic-publication-v1";
    checkedAt: string;
    provider: string;
    model: string | null;
    sourceIds: string[];
    rejectedSourceSpans: Array<{ sourceId: string; start: number; end: number }>;
    terminalVerdict: "passed" | "blocked" | "not_checked";
  };
}

export function extractSemanticClaims(text: string): Array<{ id: string; text: string }>;
export function validateSemanticClaims(
  input: { text: string; sources: Array<{ id: string | number; text: string }> },
  options?: { adapter?: SemanticClaimAdapter | null; signal?: AbortSignal; now?: () => Date },
): Promise<SemanticPublicationResult>;
