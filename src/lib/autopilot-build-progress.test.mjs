import { describe, expect, it } from "vitest";

import {
  autopilotBuildActivityAt,
  autopilotBuildProgress,
  autopilotCheckpointItem,
  autopilotRetryableItemIndexes,
  autopilotTopicCheckpoints,
  estimateAutopilotBuildMinutes,
  reusableAutopilotCheckpoint,
} from "./autopilot-build-progress.mjs";

const now = () => new Date("2026-08-18T08:00:00.000Z");
const readyQuality = {
  passed: true,
  score: 92,
  threshold: 85,
  violations: [],
  metadata: {
    checkedAt: "2026-08-18T08:00:00.000Z",
    rules: { id: "aurora-post-quality", version: 1, profileVersion: 1 },
    provenance: { kind: "deterministic", validator: "validatePostQuality", trigger: "generation" },
  },
};

describe("Autopilot durable build progress", () => {
  it("stores topic shells and strips private prompt context from completed checkpoints", () => {
    const shells = autopilotTopicCheckpoints(
      [{
        topic: "Первая",
        rubric: "Разбор",
        news: { id: "news-1", title: "Новость", text: "Факты новости" },
      }],
      ["2026-08-19T09:00:00.000Z"],
      now,
    );
    expect(shells[0]).toMatchObject({
      buildState: "queued",
      topic: "Первая",
      i: 0,
      news: { id: "news-1" },
    });

    const checkpoint = autopilotCheckpointItem({
      ...shells[0],
      aiReady: true,
      draft: "Готовый текст",
      qualityBlocked: false,
      quality: readyQuality,
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
      {
        buildState: "ready",
        checkpointedAt: "2026-08-18T08:00:00.000Z",
        aiReady: true,
        draft: "Готовый пост.",
        quality: readyQuality,
      },
      {
        buildState: "failed",
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
      ready: 1,
      failed: 1,
      percent: 20,
      stage: "generating",
    });
    expect(autopilotBuildActivityAt("2026-08-18T07:55:00.000Z", items).toISOString())
      .toBe("2026-08-18T08:02:00.000Z");
  });

  it("shows a conservative duration range that shrinks with completed posts", () => {
    expect(estimateAutopilotBuildMinutes(5)).toEqual({ min: 1, max: 1 });
    expect(estimateAutopilotBuildMinutes(30)).toEqual({ min: 3, max: 4 });
    expect(estimateAutopilotBuildMinutes(30, 15)).toEqual({ min: 2, max: 2 });
    expect(estimateAutopilotBuildMinutes(30, 30)).toEqual({ min: 0, max: 0 });
    expect(estimateAutopilotBuildMinutes(90)).toEqual({ min: 9, max: 12 });
  });

  it("never retries reader-ready, approved, or published checkpoints", () => {
    expect(autopilotRetryableItemIndexes([
      { i: 0, aiReady: true, draft: "Готовый пост.", quality: readyQuality },
      { i: 1, aiReady: false, buildState: "failed", status: "pending" },
      { i: 2, aiReady: false, buildState: "failed", status: "approved" },
      { i: 3, aiReady: false, buildState: "failed", postId: 99 },
    ])).toEqual([1]);
  });
});
