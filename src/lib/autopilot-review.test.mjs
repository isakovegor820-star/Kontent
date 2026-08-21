import { describe, expect, it } from "vitest";

import { isAutopilotReaderReadyItem } from "./autopilot-review.mjs";

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
});
