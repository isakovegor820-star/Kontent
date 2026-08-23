import { afterEach, describe, expect, it, vi } from "vitest";

import { baselineCoverage, normalizeTopicKey, opportunityConfidence, opportunityExpiry, opportunityFingerprint, release1Enabled } from "./content-intelligence";
import type { GrowthMoveRecord } from "./growth";

function move(overrides: Partial<GrowthMoveRecord> = {}): GrowthMoveRecord {
  return {
    id: 4, weekStart: "2026-08-17", kind: "topic", status: "open", confidence: "answered",
    title: "Тема", reason: "Причина", prompt: "Самостоятельный угол", actionHref: "/app/studio",
    sourceKind: "competitor_post", sourceId: "9", sourceLabel: "Источник", missingSlots: null,
    fingerprint: "a".repeat(64), rankPosition: 1, lifecycle: "open", artifactDraftId: null,
    artifactAutopilotPlanId: null, outcome: null,
    evidence: { sourceType: "Пост конкурента", sourceLabel: "Источник", href: null, sampleSize: 3,
      periodLabel: "30 дней", observedAt: "2026-08-20T00:00:00.000Z", freshnessLabel: "свежо",
      methodology: "baseline", metricLabel: "метрика", opportunityStrength: 4, urgency: 2, effort: "Среднее" },
    ...overrides,
  };
}

describe("Release 1 opportunity baseline", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    [true, true],
    [false, false],
    [undefined, false],
  ])("reads the production channel switch %s as %s", async (enabled, expected) => {
    vi.stubEnv("NODE_ENV", "production");
    const db = { query: vi.fn(async () => ({ rows: enabled === undefined ? [] : [{ enabled }] })) };
    await expect(release1Enabled(db as never, { projectId: 7, channelId: 11 })).resolves.toBe(expected);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("project_id = $1 and channel_id = $2"), [
      7, 11, "content_intelligence_release_1",
    ]);
  });
  it("is deterministic for the same immutable growth snapshot", () => {
    expect(opportunityFingerprint(move())).toBe(opportunityFingerprint(move()));
    expect(opportunityFingerprint(move({ weekStart: "2026-08-24" }))).not.toBe(opportunityFingerprint(move()));
  });

  it("does not report high confidence for a small or missing sample", () => {
    expect(opportunityConfidence(move())).toBe("high");
    expect(opportunityConfidence(move({ evidence: { ...move().evidence, sampleSize: 1 } }))).toBe("medium");
    expect(opportunityConfidence(move({ confidence: "insufficient_data", evidence: { ...move().evidence, sampleSize: null } }))).toBe("low");
  });

  it("gives every snapshot an explicit seven-day TTL", () => {
    const now = new Date("2026-08-21T10:00:00.000Z");
    expect(opportunityExpiry(null, now).toISOString()).toBe("2026-08-28T10:00:00.000Z");
  });

  it("normalizes obvious Russian duplicates without claiming semantic classification", () => {
    expect(normalizeTopicKey("Как написать пост про Ёлки — для канала"))
      .toBe(normalizeTopicKey("ёлки"));
  });

  it("derives channel-specific lexical coverage deterministically", () => {
    const posts = ["Предоплата и конфликт с клиентом: порядок разговора", "Как составить оферту"];
    expect(baselineCoverage("Предоплата без конфликта с клиентом", posts)).toBe(1);
    expect(baselineCoverage("Налоговый вычет для семьи", posts)).toBe(0);
  });
});
