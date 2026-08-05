import { describe, expect, it, vi } from "vitest";

import { orchestrateText } from "@/lib/ai-orchestrator";
import { summarizeAnalyticsCohort } from "@/lib/analytics-cohort";
import {
  buildAutopilotApprovalPreview,
  executeAutopilotApproval,
} from "../../src/lib/autopilot-approval.mjs";
import type { QualityResult } from "../../src/lib/post-quality.mjs";
import { publicationSuccessState } from "../../worker/publication-state.mjs";
import { decideTelegramReconciliation } from "../../worker/telegram-reconciliation.mjs";

describe("critical journeys with mocked external services", () => {
  it("never queues expired or unchecked autopilot items, including a repeated confirmation", async () => {
    const now = Date.parse("2026-08-01T12:00:00.000Z");
    const completeQuality: QualityResult = {
      score: 91,
      threshold: 80,
      passed: true,
      blockers: [],
      violations: [],
      metrics: { chars: 1000, emojiCount: 0, hashtagCount: 0, supportCount: 1, citedShare: 1 },
      metadata: {
        checkedAt: "2026-08-01T11:55:00.000Z",
        rules: { id: "aurora-post-quality", version: 1, profileVersion: 1 },
        provenance: {
          kind: "deterministic",
          validator: "validatePostQuality",
          trigger: "generation",
          humanAttestation: null,
        },
      },
    };
    const items = [
      { i: 1, status: "pending", scheduledAt: "2026-08-01T11:00:00.000Z", draft: "Первый", quality: completeQuality },
      { i: 2, status: "pending", scheduledAt: "2026-08-01T11:30:00.000Z", draft: "Второй", quality: completeQuality },
      { i: 3, status: "pending", scheduledAt: "2026-08-01T13:00:00.000Z", draft: "Третий" },
    ];
    const schedule = vi.fn(async () => 41);

    const preview = buildAutopilotApprovalPreview({
      items,
      nowMs: now,
      channel: { id: 7, title: "QA channel", handle: "qa" },
      planId: 9,
    });
    const first = await executeAutopilotApproval({ items, nowMs: now, schedule });
    const replay = await executeAutopilotApproval({ items: first.items, nowMs: now, schedule });

    expect(preview).toMatchObject({
      channel: { id: 7, title: "QA channel" },
      counts: { total: 3, eligible: 0, expired: 2, blocked: 1 },
      requiresConfirmation: false,
    });
    expect(first.scheduled).toBe(0);
    expect(replay.scheduled).toBe(0);
    expect(schedule).not.toHaveBeenCalled();
  });

  it("keeps Telegram truth and analytics in one verified cohort", () => {
    const provider = publicationSuccessState("tg", { ok: true, externalId: 101 });
    expect(provider).toMatchObject({
      ok: true,
      externalMessageId: "101",
      verificationState: "verified",
    });

    const temporary = decideTelegramReconciliation({
      externalMessageId: "101",
      result: { kind: "temporary_error", errorCode: "timeout", reason: "temporary" },
      consecutiveMissingChecks: 0,
    });
    expect(temporary.kind).toBe("temporary_error");

    const firstMiss = decideTelegramReconciliation({
      externalMessageId: "101",
      result: { kind: "window", oldestSeen: 99, messages: {} },
      consecutiveMissingChecks: 0,
    });
    const secondMiss = decideTelegramReconciliation({
      externalMessageId: "101",
      result: { kind: "window", oldestSeen: 99, messages: {} },
      consecutiveMissingChecks: firstMiss.kind === "suspected_missing" ? firstMiss.missingChecks : 0,
    });
    expect(firstMiss).toEqual({ kind: "suspected_missing", missingChecks: 1 });
    expect(secondMiss).toEqual({ kind: "confirmed_missing", missingChecks: 2 });

    const before = summarizeAnalyticsCohort([
      { status: "published", verification_state: "verified", views: 5 },
      { status: "published_unverified", verification_state: "unverified", views: 17 },
    ]);
    const after = summarizeAnalyticsCohort([
      { status: "missing", verification_state: "missing", views: 5 },
      { status: "published_unverified", verification_state: "unverified", views: 17 },
    ]);
    expect(before).toMatchObject({ totalViews: 5, avgViews: 5, unverified: 1 });
    expect(after).toMatchObject({ totalViews: 0, avgViews: null, missing: 1, unverified: 1 });
  });

  it("falls back before the first token and returns one unmixed AI result", async () => {
    const streamFactory = vi.fn(async function* (_params, engine) {
      if (engine === "navy-deepseek-pro") throw new TypeError("mock network failure");
      yield "Результат ";
      yield "резервной модели";
    });
    const events = [];

    for await (const event of orchestrateText(
      { kind: "write", task: "Короткий детерминированный бриф" },
      "navy-deepseek-pro",
      {
        fallbackEngines: ["navy-deepseek-flash"],
        firstTokenMs: 100,
        overallMs: 1_000,
        streamFactory,
        circuitBreaker: null,
      },
    )) {
      events.push(event);
    }

    expect(events).toContainEqual(expect.objectContaining({
      type: "fallback",
      fromEngine: "navy-deepseek-pro",
      toEngine: "navy-deepseek-flash",
      reason: "network_error",
    }));
    expect(events.filter((event) => event.type === "delta").map((event) => event.text).join(""))
      .toBe("Результат резервной модели");
    expect(streamFactory).toHaveBeenCalledTimes(2);
  });
});
