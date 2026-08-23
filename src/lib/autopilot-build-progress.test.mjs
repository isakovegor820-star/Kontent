import { describe, expect, it } from "vitest";

import {
  autopilotBuildActivityAt,
  autopilotBuildProgress,
  autopilotCheckpointItem,
  autopilotProviderWaitingItem,
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

  it("keeps a provider outage separate from editorial failure and resumes only that slot", () => {
    const waiting = autopilotProviderWaitingItem({
      item: {
        i: 2,
        topic: "Тема",
        rubric: "Разбор",
        draft: "Старый готовый дубль",
        aiReady: true,
        autoApprove: true,
        quality: readyQuality,
        reviewState: "editorial_review",
      },
      topic: { topic: "Тема", rubric: "Разбор" },
      scheduledAt: "2026-08-20T09:00:00.000Z",
      error: { code: "provider_timeout", engine: "navy-deepseek-flash", status: 504 },
      now,
    });
    const checkpoint = autopilotCheckpointItem(waiting, now);

    expect(checkpoint).toMatchObject({
      i: 2,
      aiReady: false,
      draft: "",
      buildState: "waiting_provider",
      _providerFailure: { code: "provider_timeout", status: 504 },
    });
    expect(checkpoint).not.toHaveProperty("autoApprove");
    expect(checkpoint).not.toHaveProperty("quality");
    expect(checkpoint).not.toHaveProperty("reviewState");
    expect(autopilotBuildProgress([checkpoint], 7)).toMatchObject({ ready: 0, failed: 0 });
    expect(autopilotRetryableItemIndexes([checkpoint])).toEqual([2]);
  });
});
