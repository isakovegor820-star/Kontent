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

  it("delivers the shape the live adapter actually returns", () => {
    // Production's first finished build lost six of ten posts here. The adapter answers,
    // labels headings and calls to action `non_factual`, and returns `adapter_unknown` for
    // the claims it cannot settle. The gate accepted neither, so posts with nothing against
    // them became `failed` and the week landed `partial` at four posts.
    const semantic = {
      version: 1,
      status: "not_checked",
      passed: false,
      requiresReview: true,
      blockers: [],
      claimVerdicts: [
        { claimId: "c1", verdict: "non_factual", reasonCode: "heading", riskCodes: [], sourceSpans: [] },
        { claimId: "c2", verdict: "supported", reasonCode: "entailed_by_source", riskCodes: [], sourceSpans: [] },
        { claimId: "c3", verdict: "unknown", reasonCode: "adapter_unknown", riskCodes: [], sourceSpans: [] },
      ],
      provenance: {
        validatorVersion: "semantic-publication-v1",
        checkedAt: "2026-09-01T10:57:00.000Z",
        provider: "aurora-semantic-ai-v1",
        model: "deepseek-v4-flash",
        sourceIds: [],
        rejectedSourceSpans: [],
        terminalVerdict: "not_checked",
      },
    };
    const item = {
      aiReady: true,
      draft: "Готовый пост, у которого проверяльщик не смог решить одно утверждение",
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
        semantic,
      },
    };

    expect(isAutopilotHumanReviewItem(item)).toBe(true);
    // A person still has to approve it: this is never an automatic publication.
    expect(isAutopilotReaderReadyItem(item)).toBe(false);

    // A finding about the claim is not the checker giving up, and stays out of the week.
    expect(isAutopilotHumanReviewItem({
      ...item,
      quality: {
        ...item.quality,
        semantic: {
          ...semantic,
          claimVerdicts: [
            ...semantic.claimVerdicts,
            { claimId: "c4", verdict: "unknown", reasonCode: "unverified_universality", riskCodes: [], sourceSpans: [] },
          ],
        },
      },
    })).toBe(false);

    // Nothing unsettled means the checker did reach a verdict; that is not this path.
    expect(isAutopilotHumanReviewItem({
      ...item,
      quality: {
        ...item.quality,
        semantic: {
          ...semantic,
          claimVerdicts: semantic.claimVerdicts.filter((verdict) => verdict.verdict !== "unknown"),
        },
      },
    })).toBe(false);

    // An unsupported claim can never be waved through by reading.
    expect(isAutopilotHumanReviewItem({
      ...item,
      quality: {
        ...item.quality,
        semantic: {
          ...semantic,
          claimVerdicts: [
            ...semantic.claimVerdicts,
            { claimId: "c5", verdict: "unsupported", reasonCode: "source_contradiction", riskCodes: [], sourceSpans: [] },
          ],
        },
      },
    })).toBe(false);

    // Provenance must still identify a checker that ran.
    expect(isAutopilotHumanReviewItem({
      ...item,
      quality: {
        ...item.quality,
        semantic: { ...semantic, provenance: { ...semantic.provenance, provider: "" } },
      },
    })).toBe(false);
  });
});
