import { describe, expect, it } from "vitest";

import {
  isAutopilotHumanReviewItem,
  isAutopilotReaderReadyItem,
} from "./autopilot-review.mjs";

const quality = {
  passed: true,
  score: 92,
  threshold: 85,
  blockers: [],
  violations: [],
  metadata: {
    checkedAt: "2026-08-21T08:00:00.000Z",
    rules: { id: "aurora-post-quality", version: 1, profileVersion: 1 },
    provenance: { kind: "deterministic", validator: "validatePostQuality", trigger: "generation" },
  },
};

describe("Autopilot reader-ready boundary", () => {
  it("accepts only a verified clean draft", () => {
    expect(isAutopilotReaderReadyItem({
      aiReady: true,
      draft: "Готовый пост",
      qualityBlocked: false,
      reviewRequired: false,
      quality,
    })).toBe(true);
  });

  it("keeps failed quality and invented specifics inside the generator", () => {
    expect(isAutopilotReaderReadyItem({
      aiReady: true,
      draft: "Сырой пост",
      qualityBlocked: true,
      reviewRequired: true,
      reviewState: "quality_review",
      quality: { ...quality, passed: false },
    })).toBe(false);
    expect(isAutopilotReaderReadyItem({
      aiReady: true,
      draft: "Пост с выдуманной датой",
      invented: ["24 сентября"],
      quality,
    })).toBe(false);
  });

  it("delivers a semantic checkpoint when the live validator failed closed", () => {
    const semanticReview = {
      aiReady: true,
      draft: "Текст ждёт проверки человеком",
      qualityBlocked: true,
      reviewRequired: true,
      reviewState: "semantic_only_review",
      quality: {
        ...quality,
        publicationDisposition: "confirmation_required",
        violations: [{
          code: "semantic_review_required",
          message: "Смысл требует ручной проверки",
          blocker: false,
          penalty: 0,
        }],
        semantic: {
          version: 1,
          status: "not_checked",
          passed: false,
          requiresReview: true,
          blockers: [],
          claimVerdicts: [{
            claimId: "claim-1",
            claim: "Текст ждёт проверки человеком",
            verdict: "unknown",
            reasonCode: "semantic_provider_failed",
            riskCodes: [],
            sourceSpans: [],
          }],
          provenance: {
            validatorVersion: "semantic-publication-v1",
            checkedAt: "2026-08-30T08:00:00.000Z",
            provider: "aurora-semantic-ai-v1",
            model: "deepseek-v4-flash",
            sourceIds: [],
            rejectedSourceSpans: [],
            terminalVerdict: "not_checked",
          },
        },
      },
    };

    expect(isAutopilotHumanReviewItem(semanticReview)).toBe(true);
    expect(isAutopilotReaderReadyItem(semanticReview)).toBe(false);
    expect(isAutopilotHumanReviewItem({
      ...semanticReview,
      quality: {
        ...semanticReview.quality,
        semantic: {
          ...semanticReview.quality.semantic,
          claimVerdicts: [{
            ...semanticReview.quality.semantic.claimVerdicts[0],
            reasonCode: "semantic_verdict_missing",
          }],
        },
      },
    })).toBe(false);
  });
});
