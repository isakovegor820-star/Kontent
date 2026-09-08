import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { selectAutopilotCandidates } from "./autopilot-candidate-selection.mjs";
import { selectAutopilotRepairs } from "./autopilot-repair-selection.mjs";
import { autopilotBuildProgress, autopilotCheckpointItem, reusableAutopilotCheckpoint } from "./autopilot-build-progress.mjs";
import { autopilotBuildAttemptDto } from "./autopilot-build-attempt.mjs";
import { evaluateAutopilotItem } from "./autopilot-approval.mjs";
import { autopilotDraftsDeliverable } from "../../worker/lib.mjs";

const checkedAt = "2026-09-08T12:00:00.000Z";
const readyQuality = {
  passed: true, score: 95, threshold: 85, blockers: [], violations: [],
  publicationDisposition: "ready",
  metadata: {
    checkedAt, rules: { id: "aurora-post-quality", version: 1, profileVersion: 1 },
    provenance: { kind: "deterministic", validator: "validatePostQuality", trigger: "generation" },
  },
  semantic: {
    version: 1, status: "passed", passed: true, requiresReview: false,
    claimVerdicts: [{ verdict: "non_factual", sourceSpans: [] }],
    provenance: { validatorVersion: "semantic-publication-v1", checkedAt, provider: "test", terminalVerdict: "passed" },
  },
};
function item(i, code = null) {
  // Independent text identities make this a readiness test, not a near-duplicate fixture.
  const text = Array.from({ length: 8 }, (_, n) => createHash("sha256").update(`${i}:${n}`).digest("hex")).join(" ");
  return autopilotCheckpointItem({
    i, topic: text.slice(0, 50), draft: `${text}.`, status: "pending",
    scheduledAt: "2026-09-10T12:00:00.000Z", aiReady: true,
    qualityBlocked: Boolean(code), reviewRequired: Boolean(code),
    reviewState: code ? "editorial_review" : undefined,
    quality: code ? {
      ...readyQuality, score: 100, publicationDisposition: "confirmation_required", repairStrategy: "rewrite",
      violations: [{ code, blocker: code === "hook", penalty: 0 }],
    } : readyQuality,
  });
}

describe("finished Autopilot plan across selection, recovery, progress and approval", () => {
  it("repairs the production 24+4 shape and only then completes all 28 posts", () => {
    const posts = Array.from({ length: 28 }, (_, i) => item(i, i < 24 ? null : i === 27 ? "hook" : "too_short"));
    const first = selectAutopilotCandidates(posts, { targetCount: 28 });
    expect(first.complete).toBe(false);
    expect(first.selected).toHaveLength(24);
    expect(autopilotDraftsDeliverable(28, posts, posts)).toBe(false);
    expect(autopilotBuildProgress(posts, 28)).toMatchObject({ ready: 24, failed: 4 });
    // Legacy reports counted human-review posts as selected. They must not show 100%.
    const progress = autopilotBuildAttemptDto({
      id: 87, status: "partial", expected_post_count: 28,
      items: posts, build_report: { selectedCount: 28, selectionDeficit: 0 }, created_at: checkedAt,
    });
    expect(progress).toMatchObject({ readyCount: 24, retryableItemIndexes: [24, 25, 26, 27] });

    const repair = selectAutopilotRepairs(posts, { count: 4 });
    expect(repair).toEqual({ indexes: [24, 25, 26, 27], strategy: "rewrite" });
    expect(reusableAutopilotCheckpoint(posts[0], posts[0], posts[0].scheduledAt)).toBe(true);
    expect(reusableAutopilotCheckpoint(posts[24], posts[24], posts[24].scheduledAt)).toBe(false);
    const repaired = posts.map((post) => repair.indexes.includes(post.i) ? item(post.i) : post);
    expect(repaired.slice(0, 24).every((post, i) => post === posts[i])).toBe(true);
    const finished = selectAutopilotCandidates(repaired, { targetCount: 28 });
    expect(finished.complete).toBe(true);
    expect(autopilotDraftsDeliverable(28, finished.selected, finished.selected)).toBe(true);
    expect(finished.selected.every((post) => evaluateAutopilotItem(post, Date.parse(checkedAt)).eligible)).toBe(true);
  });

  it("uses ready reserve before high-scoring editorial or semantic review candidates, including news", () => {
    const pending = { ...item(28, "too_short"), news: true };
    const semanticPending = {
      ...item(29, "semantic_review_required"), news: true,
      quality: { ...pending.quality, publicationDisposition: "confirmation_required", repairStrategy: "provider_retry" },
    };
    const posts = [pending, semanticPending, ...Array.from({ length: 28 }, (_, i) => item(i))];
    const chosen = selectAutopilotCandidates(posts, { targetCount: 28, newsQuota: 2 });
    expect(chosen.complete).toBe(true);
    expect(chosen.selected.every((post) => post.quality.publicationDisposition === "ready")).toBe(true);
    expect(chosen.selected.some((post) => post.i >= 28)).toBe(false);
  });

  it("repairs actionable posts even when missing evidence dominates the discarded reserve", () => {
    const missing = Array.from({ length: 5 }, (_, i) => ({
      ...item(i, "no_sources"), quality: { ...readyQuality, passed: false, publicationDisposition: "blocked", repairStrategy: "add_knowledge" },
    }));
    const posts = [...missing, item(5, "too_short"), item(6, "hook"), item(7)];
    expect(selectAutopilotRepairs(posts, { count: 2 })).toEqual({ indexes: [5, 6], strategy: "rewrite" });
    expect(selectAutopilotRepairs(posts, { count: 2, scopeIndexes: [6] }).indexes).toEqual([6]);
    expect(selectAutopilotRepairs(posts, { count: 1, retriedIndexes: [5] }).indexes).toEqual([6]);
    expect(selectAutopilotRepairs(missing, { count: 2 })).toEqual({ indexes: [], strategy: null });
    expect(selectAutopilotRepairs([{ ...item(8, "hook"), status: "approved", postId: 123 }], { count: 1 }).indexes).toEqual([]);
  });
});
