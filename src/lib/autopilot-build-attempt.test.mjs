import { describe, expect, it } from "vitest";

import {
  autopilotBuildAttemptDto,
  serializeAutopilotActivePlan,
  serializeAutopilotPublicItem,
} from "./autopilot-build-attempt.mjs";

const readyQuality = {
  passed: true,
  score: 91,
  threshold: 85,
  publicationDisposition: "ready",
  repairStrategy: null,
  violations: [],
  metadata: {
    checkedAt: "2026-08-21T10:00:00.000Z",
    rules: { id: "aurora-post-quality", version: 1, profileVersion: 1 },
    provenance: { kind: "deterministic", validator: "validatePostQuality", trigger: "generation" },
  },
};

describe("Autopilot public serialization", () => {
  it("never exposes prompt, support, embedding, stack, or transient approval fields", () => {
    const item = serializeAutopilotPublicItem({
      i: 0,
      topic: "Тема",
      draft: "Готовый пост.",
      scheduledAt: "2026-08-22T10:00:00.000Z",
      status: "pending",
      aiReady: true,
      quality: {
        ...readyQuality,
        _debug: "secret",
        prompt: "secret",
        semantic: {
          status: "passed",
          reviewClaims: [{ claim: "private claim" }],
          claimVerdicts: [{ claim: "private claim", verdict: "supported", sourceSpans: [{ sourceId: "private-source", start: 1, end: 4 }] }],
          provenance: { provider: "private-provider" },
        },
      },
      _support: [{ text: "private source" }],
      _system: "secret system",
      _task: "secret task",
      sourceEmbeddings: [0.1, 0.2],
      stack: "private stack",
      autoApprove: true,
    });

    expect(item).toMatchObject({ i: 0, topic: "Тема", draft: "Готовый пост." });
    const serialized = JSON.stringify(item);
    for (const secret of [
      "secret system",
      "secret task",
      "private source",
      "sourceEmbeddings",
      "autoApprove",
      "private stack",
      "systemPrompt",
      "secret",
      "private claim",
      "private-source",
      "private-provider",
    ]) expect(serialized).not.toContain(secret);
    expect(serialized).toContain("supported");
  });

  it("separates a usable active plan from partial build progress", () => {
    const activePlan = serializeAutopilotActivePlan({
      id: 70,
      revision: 2,
      status: "pending",
      items: [],
      planning_weeks: 1,
      expected_post_count: 5,
      created_at: "2026-08-21T09:00:00.000Z",
    });
    const attempt = autopilotBuildAttemptDto({
      id: 91,
      revision: 5,
      status: "partial",
      expected_post_count: 5,
      publication_target_count: 5,
      candidate_count: 7,
      build_activity_at: "2026-08-21T10:00:00.000Z",
      items: [
        {
          i: 0,
          topic: "Готовая тема",
          draft: "Готовый пост.",
          scheduledAt: "2026-08-22T10:00:00.000Z",
          status: "pending",
          aiReady: true,
          quality: readyQuality,
        },
        {
          i: 1,
          topic: "Проблемная тема",
          draft: "",
          status: "pending",
          aiReady: false,
          buildState: "failed",
        },
      ],
    }, 7);

    expect(activePlan).toMatchObject({ id: 70, status: "pending", expectedPostCount: 5 });
    expect(attempt).toMatchObject({
      planId: 91,
      status: "partial",
      targetCount: 5,
      publicationTargetCount: 5,
      candidateCount: 7,
      readyCount: 1,
      failedCount: 4,
      retryableItemIndexes: [1],
    });
    expect(attempt.readerReadyItems).toHaveLength(1);
  });

  it("offers repair only for the publication deficit, not every failed reserve candidate", () => {
    const readyItems = Array.from({ length: 4 }, (_, i) => ({
      i,
      topic: `Готовая тема ${i}`,
      draft: `Готовый пост ${i}.`,
      scheduledAt: `2026-08-${22 + i}T10:00:00.000Z`,
      status: "pending",
      aiReady: true,
      quality: readyQuality,
    }));
    const failedItems = Array.from({ length: 3 }, (_, offset) => ({
      i: offset + 4,
      topic: `Проблемная тема ${offset}`,
      draft: "",
      status: "pending",
      aiReady: false,
      buildState: "failed",
      ...(offset === 0 ? { news: { title: "Новость" } } : {}),
    }));

    const attempt = autopilotBuildAttemptDto({
      id: 92,
      status: "partial",
      expected_post_count: 5,
      publication_target_count: 5,
      candidate_count: 7,
      build_report: { selectionDeficit: 1 },
      items: [...readyItems, ...failedItems],
      created_at: "2026-08-21T10:00:00.000Z",
    }, 7);

    expect(attempt.retryableItemIndexes).toEqual([4]);
    expect(attempt).toMatchObject({ readyCount: 4, failedCount: 3, publicationTargetCount: 5 });
  });

  it("exposes automatic provider recovery without counting waiting slots as bad posts", () => {
    const attempt = autopilotBuildAttemptDto({
      id: 93,
      revision: 8,
      status: "building",
      expected_post_count: 7,
      publication_target_count: 7,
      candidate_count: 10,
      build_report: {
        recoveryState: "waiting_provider",
        providerFailureCode: "provider_timeout",
        attemptNumber: 2,
        maxAttempts: 6,
        nextRetryAt: "2026-08-21T10:00:20.000Z",
      },
      items: [{
        i: 0,
        topic: "Ожидающая тема",
        draft: "",
        aiReady: false,
        status: "pending",
        buildState: "waiting_provider",
      }],
      created_at: "2026-08-21T10:00:00.000Z",
    }, 10);

    expect(attempt).toMatchObject({
      status: "building",
      recoveryState: "waiting_provider",
      providerFailureCode: "provider_timeout",
      attemptNumber: 2,
      maxAttempts: 6,
      failedCount: 0,
      retryableItemIndexes: [0],
    });
  });
});
