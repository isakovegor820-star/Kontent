import { describe, expect, it } from "vitest";

import type { DraftAiValidation } from "./draft-types";
import {
  composerAiReviewState,
  draftReviewAssessment,
  draftReviewDecision,
  isDraftRecoveryAllowedReason,
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
  it("keeps validation diagnostics without quarantining an immutable result", () => {
    expect(draftReviewDecision(input({ ai_validation: validation("passed") }))).toBe("allowed");
    expect(draftReviewDecision(input({ ai_validation: validation("blocked") }))).toBe("allowed");
    const reviewableBlocked = { ...validation("blocked"), requiresReview: true };
    expect(normalizeDraftAiValidation(reviewableBlocked)).toEqual(reviewableBlocked);
    const current = {
      policy_version: 1 as const,
      draft_version: 4,
      attested_at: "2026-08-02T10:05:00.000Z",
    };
    expect(draftReviewDecision(input({ ai_validation: reviewableBlocked, human_review: current }))).toBe("allowed");
    expect(composerAiReviewState(input({ ai_validation: reviewableBlocked, human_review: current }))).toBe("none");
  });

  it("accepts human review only for the exact current draft version", () => {
    const current = {
      policy_version: 1 as const,
      draft_version: 4,
      attested_at: "2026-08-02T10:05:00.000Z",
    };
    expect(draftReviewDecision(input({ ai_validation: null, generation_binding_valid: false, human_review: current }))).toBe("allowed");
    expect(
      draftReviewDecision(input({ ai_validation: null, generation_binding_valid: false, version: 5, human_review: current })),
    ).toBe("review_required");
    expect(composerAiReviewState(input({ ai_validation: null, generation_binding_valid: false, human_review: current }))).toBe("none");
  });

  it("fails closed for missing, stale-policy, or malformed provenance", () => {
    expect(draftReviewDecision(input({ ai_validation: null }))).toBe("review_required");
    expect(draftReviewDecision(input({ review_policy_version: 2 }))).toBe("review_required");
    const malformed = { ...validation("passed"), provenance: { validatorVersion: "client-v1" } };
    expect(normalizeDraftAiValidation(malformed)).toBeNull();
    expect(draftReviewDecision(input({ ai_validation: malformed }))).toBe("blocked");
    expect(draftReviewAssessment(input({ ai_validation: malformed }))).toEqual({
      decision: "blocked",
      blockedReason: "malformed_validation",
    });
  });

  it("returns exact typed reasons for every permanent block", () => {
    expect(draftReviewAssessment(input({ generation_result_id: null }))).toEqual({
      decision: "blocked",
      blockedReason: "legacy_generation_missing",
    });
    expect(draftReviewAssessment(input({ ai_validation: validation("blocked") }))).toEqual({
      decision: "allowed",
      blockedReason: null,
    });
    expect(draftReviewAssessment(input({ purpose: "source_context", origin: "rss" }))).toEqual({
      decision: "blocked",
      blockedReason: "source_context_not_publishable",
    });
    expect(draftReviewAssessment(input({
      ai_validation: validation("passed"),
      generation_binding_valid: false,
    }))).toEqual({
      decision: "blocked",
      blockedReason: "unknown_block",
    });
  });

  it("never blocks manual-origin drafts", () => {
    expect(
      draftReviewDecision(input({ origin: "manual", ai_validation: validation("blocked") })),
    ).toBe("allowed");
  });

  it("allows recovery only for permanent structural blocks", () => {
    expect(isDraftRecoveryAllowedReason("legacy_generation_missing")).toBe(true);
    expect(isDraftRecoveryAllowedReason(null)).toBe(false);
  });
});
