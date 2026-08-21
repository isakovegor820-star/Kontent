import { describe, expect, it } from "vitest";

import { autopilotPlanNeedsQualityRebuild } from "./autopilot-plan-visibility.mjs";

const verifiedQuality = {
  score: 91,
  threshold: 85,
  passed: true,
  blockers: [],
  violations: [],
  metadata: {
    checkedAt: "2026-08-14T20:15:00.000Z",
    rules: { id: "aurora-post-quality", version: 1, profileVersion: 1 },
    provenance: {
      kind: "deterministic",
      validator: "validatePostQuality",
      trigger: "generation",
      humanAttestation: null,
    },
  },
};

const planItem = (overrides = {}) => ({
  status: "pending",
  qualityOrigin: "automatic",
  quality: verifiedQuality,
  ...overrides,
});

describe("Autopilot plan visibility", () => {
  it("requires a rebuild when a failed draft is not marked as needing work", () => {
    const ready = Array.from({ length: 12 }, () => planItem());
    const blocked = Array.from({ length: 16 }, () =>
      planItem({
        quality: {
          ...verifiedQuality,
          score: 74,
          passed: false,
          blockers: ["Нужна ручная правка"],
        },
      }),
    );

    expect(autopilotPlanNeedsQualityRebuild([...ready, ...blocked])).toBe(true);
  });

  it("requires a rebuild when a provider returned only a placeholder", () => {
    expect(autopilotPlanNeedsQualityRebuild([
      planItem({ aiReady: false, draft: "ИИ допишет позже" }),
    ])).toBe(true);
  });

  it("keeps a fully verified automatic plan visible", () => {
    expect(autopilotPlanNeedsQualityRebuild([
      planItem({ aiReady: true, qualityBlocked: false }),
      planItem({ aiReady: true, qualityBlocked: false }),
    ])).toBe(false);
  });

  it("keeps a marked review draft visible: approval stays closed elsewhere", () => {
    expect(autopilotPlanNeedsQualityRebuild([
      planItem({
        aiReady: true,
        draft: "Черновик для ручной проверки",
        qualityBlocked: true,
        reviewRequired: true,
        quality: {
          ...verifiedQuality,
          semantic: { status: "not_checked", requiresReview: true },
        },
      }),
    ])).toBe(false);
  });

  it("keeps an exact semantic-provider-unavailable draft visible for human review", () => {
    expect(autopilotPlanNeedsQualityRebuild([
      planItem({
        aiReady: true,
        draft: "Черновик с пройденными deterministic-проверками",
        qualityBlocked: true,
        reviewRequired: true,
        reviewState: "semantic_only_review",
        quality: {
          ...verifiedQuality,
          violations: [{
            code: "semantic_review_required",
            message: "Semantic provider unavailable",
            blocker: true,
            penalty: 0,
          }],
          semantic: {
            version: 1,
            status: "not_checked",
            passed: false,
            requiresReview: true,
            claimVerdicts: [{ verdict: "unknown", reasonCode: "semantic_provider_unavailable" }],
            provenance: {
              validatorVersion: "semantic-publication-v1",
              provider: "unavailable",
              terminalVerdict: "not_checked",
            },
          },
        },
      }),
    ])).toBe(false);
  });

  // Четыре готовых поста не должны исчезать из-за пятого, который просит правки: текст
  // уже написан, и человек может его дописать — а из состояния «пересобери» не может ничего.
  it("keeps a marked short draft visible instead of hiding the whole plan", () => {
    const short = planItem({
      aiReady: true,
      draft: "Слишком короткий черновик",
      qualityBlocked: true,
      reviewRequired: true,
      quality: {
        ...verifiedQuality,
        passed: false,
        score: 75,
        violations: [{
          code: "too_short",
          message: "Нужно минимум 900 знаков, сейчас 659",
          blocker: true,
          penalty: 25,
        }],
      },
    });
    expect(autopilotPlanNeedsQualityRebuild([planItem(), short])).toBe(false);
    // Без пометки тот же пост выглядел бы готовым — такой план по-прежнему скрываем.
    expect(
      autopilotPlanNeedsQualityRebuild([{ ...short, reviewRequired: false }]),
    ).toBe(true);
  });

  it("requires a rebuild for a pending legacy automatic draft without verified metadata", () => {
    const legacyQuality = { ...verifiedQuality };
    delete legacyQuality.metadata;

    expect(autopilotPlanNeedsQualityRebuild([planItem({ quality: legacyQuality })])).toBe(true);
  });

  it("does not hide manually reviewed or completed legacy items", () => {
    expect(
      autopilotPlanNeedsQualityRebuild([
        planItem({ qualityOrigin: "human_attested", quality: undefined }),
        planItem({ status: "approved", quality: undefined }),
      ]),
    ).toBe(false);
  });
});
