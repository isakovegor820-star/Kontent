import { describe, expect, it } from "vitest";

import type { DraftAiValidation } from "./draft-types";
import { studioEditorialIntent } from "./studio-editorial";
import { generationBindingValid, generationResultHash } from "./generation-artifacts";
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


describe("editorial topic receipt boundary", () => {
  it("never splits a Unicode scalar at the JSONB receipt boundary", () => {
    const task = "Д".repeat(1799) + "😀";
    const intent = studioEditorialIntent({ kind: "rewrite", task, grounding: "platform" });
    expect(intent?.topic).toBe("Д".repeat(1799));
    expect(studioEditorialIntent({ kind: "rewrite", task: "Д".repeat(1798) + "😀", grounding: "platform" })?.topic).toBe("Д".repeat(1798) + "😀");
  });

  it.each([500, 501, 1800, 1801])("preserves the producer topic for a %i-character task through the receipt", (length) => {
    const task = "Д".repeat(length - 1) + "я";
    const intent = studioEditorialIntent({ kind: "rewrite", task, grounding: "platform" });
    expect(intent?.topic).toBe(task.slice(0, 1800));
    for (const status of ["passed", "blocked", "not_checked"] as const) {
      const receipt = { ...validation(status), topicAlignment: { status: "passed" as const, score: 0.96, topic: intent!.topic } };
      expect(normalizeDraftAiValidation(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
    }
  });

  it.each([500, 501, 1800])("binds only the exact %i-character validation topic to immutable output", (length) => {
    const receipt = { ...validation("passed"), topicAlignment: { status: "passed" as const, score: 0.96, topic: "Д".repeat(length - 1) + "я" } };
    const text = "Полный неизменяемый результат";
    const hash = generationResultHash(text);
    const binding = { generationResultId: 81, text, resultHash: hash, receiptHash: hash, aiValidation: receipt, receipt };
    expect(generationBindingValid(binding)).toBe(true);
    expect(generationBindingValid({ ...binding, receipt: { ...receipt, topicAlignment: { ...receipt.topicAlignment, topic: "Д".repeat(length) } } })).toBe(false);
    expect(generationBindingValid({ ...binding, text: text + " изменён" })).toBe(false);
    expect(generationBindingValid({ ...binding, receiptHash: "0".repeat(64) })).toBe(false);
  });

  it.each([1801, 10000])("rejects an over-limit %i-character receipt without silently truncating it", (length) => {
    const receipt = { ...validation("passed"), topicAlignment: { status: "passed", score: 0.96, topic: "Д".repeat(length) } };
    expect(normalizeDraftAiValidation(receipt)).toBeNull();
    expect(draftReviewAssessment(input({ ai_validation: receipt }))).toEqual({ decision: "blocked", blockedReason: "malformed_validation" });
  });

  it.each([
    { topic: " ".repeat(1800) },
    { topic: 1800 },
    { status: "unknown" },
    { score: 1.01 },
    { score: -0.01 },
    { score: "0.96" },
  ])("keeps strict topic validation for %j", (patch) => {
    expect(normalizeDraftAiValidation({ ...validation("passed"), topicAlignment: { status: "passed", score: 0.96, topic: "Д".repeat(1800), ...patch } })).toBeNull();
  });
});
