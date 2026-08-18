import { describe, expect, it } from "vitest";

import {
  autopilotBuildActivityAt,
  autopilotBuildProgress,
  autopilotCheckpointItem,
  autopilotTopicCheckpoints,
  reusableAutopilotCheckpoint,
} from "./autopilot-build-progress.mjs";

const now = () => new Date("2026-08-18T08:00:00.000Z");

describe("Autopilot durable build progress", () => {
  it("stores topic shells and strips private prompt context from completed checkpoints", () => {
    const shells = autopilotTopicCheckpoints(
      [{ topic: "Первая", rubric: "Разбор" }],
      ["2026-08-19T09:00:00.000Z"],
      now,
    );
    expect(shells[0]).toMatchObject({ buildState: "queued", topic: "Первая", i: 0 });

    const checkpoint = autopilotCheckpointItem({
      ...shells[0],
      aiReady: true,
      draft: "Готовый текст",
      qualityBlocked: false,
      quality: { passed: true },
      autoApprove: true,
      _system: "SECRET PROMPT",
      _support: [{ text: "full source" }],
    }, now);
    expect(checkpoint).not.toHaveProperty("_system");
    expect(checkpoint).not.toHaveProperty("_support");
    expect(checkpoint).not.toHaveProperty("autoApprove");
    expect(reusableAutopilotCheckpoint(checkpoint, shells[0], shells[0].scheduledAt)).toBe(true);
  });

  it("reports completed posts and uses the latest checkpoint as build activity", () => {
    const items = [
      { buildState: "queued", checkpointedAt: "2026-08-18T08:00:00.000Z" },
      {
        buildState: "review_required",
        checkpointedAt: "2026-08-18T08:02:00.000Z",
        aiReady: true,
        draft: "Проверить вручную",
        reviewRequired: true,
      },
    ];
    expect(autopilotBuildProgress(items, 5)).toEqual({
      completed: 1,
      total: 5,
      reviewRequired: 1,
      percent: 20,
      stage: "generating",
    });
    expect(autopilotBuildActivityAt("2026-08-18T07:55:00.000Z", items).toISOString())
      .toBe("2026-08-18T08:02:00.000Z");
  });
});
