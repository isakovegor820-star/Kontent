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
  it("requires a rebuild instead of presenting a mixed-quality plan as ready", () => {
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
