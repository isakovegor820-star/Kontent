import { describe, expect, it } from "vitest";

import type { DraftAiValidation } from "./draft-types";
import {
  composerAiReviewState,
  draftReviewDecision,
  normalizeDraftAiValidation,
} from "./draft-review";

const validation = (status: DraftAiValidation["status"]): DraftAiValidation => ({
  version: 1,
  status,
  requiresReview: status === "not_checked",
  blockerCodes: status === "blocked" ? ["unsupported_claim"] : [],
  provenance: {
    validatorVersion: "fact-ledger-v1",
    ledgerHash: "fl1-1234abcd",
    checkedAt: "2026-08-02T10:00:00.000Z",
    coverage: status === "passed" ? "deterministic+semantic" : "deterministic",
    semanticEntailment: status === "passed"
      ? "passed"
      : status === "not_checked"
        ? "not_checked"
        : "not_run",
    rulesRun: ["unsupported_claim"],
    sourceIds: ["brief:1"],
  },
});

const input = (overrides: Record<string, unknown> = {}) => ({
  origin: "ai" as const,
  purpose: "publishable" as const,
  generation_result_id: 81,
  generation_binding_valid: true,
  version: 4,
  review_policy_version: 1 as const,
  ai_validation: validation("not_checked"),
  human_review: null,
  ...overrides,
});

describe("AI draft review policy", () => {
  it("allows a complete passed validation and blocks a factual failure", () => {
    expect(draftReviewDecision(input({ ai_validation: validation("passed") }))).toBe("allowed");
    expect(draftReviewDecision(input({ ai_validation: validation("blocked") }))).toBe("blocked");
    const reviewableBlocked = { ...validation("blocked"), requiresReview: true };
    expect(normalizeDraftAiValidation(reviewableBlocked)).toEqual(reviewableBlocked);
    expect(draftReviewDecision(input({ ai_validation: reviewableBlocked }))).toBe("blocked");
  });

  it("accepts human review only for the exact current draft version", () => {
    const current = {
      policy_version: 1 as const,
      draft_version: 4,
      attested_at: "2026-08-02T10:05:00.000Z",
    };
    expect(draftReviewDecision(input({ human_review: current }))).toBe("allowed");
    expect(
      draftReviewDecision(input({ version: 5, human_review: current })),
    ).toBe("review_required");
    expect(composerAiReviewState(input({ human_review: current }))).toBe("none");
  });

  it("fails closed for missing, stale-policy, or malformed provenance", () => {
    expect(draftReviewDecision(input({ ai_validation: null }))).toBe("review_required");
    expect(draftReviewDecision(input({ review_policy_version: 2 }))).toBe("review_required");
    const malformed = { ...validation("passed"), provenance: { validatorVersion: "client-v1" } };
    expect(normalizeDraftAiValidation(malformed)).toBeNull();
    expect(draftReviewDecision(input({ ai_validation: malformed }))).toBe("review_required");
  });

  it("never blocks manual-origin drafts", () => {
    expect(
      draftReviewDecision(input({ origin: "manual", ai_validation: validation("blocked") })),
    ).toBe("allowed");
  });
});
