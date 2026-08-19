import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = await readFile(new URL("../worker.mjs", import.meta.url), "utf8");

describe("Autopilot ready-plan generation contract", () => {
  it("never accepts a provider response stopped at the token limit", () => {
    expect(source).not.toContain('acceptLengthLimitedOutput: surface === "autopilot-plan"');
  });

  it("caps rewrites and only relaxes delivery for confirmation mode", () => {
    expect(source).toContain("const AUTOPILOT_QUALITY_REWRITE_ATTEMPTS = 2;");
    expect(source).toContain("autopilotDraftsDeliverable(N, topics, items)");
    expect(source).toContain("full\n    ? autopilotBuildComplete(N, topics, items)");
  });

  it("runs manual builds on a dedicated resumable queue", () => {
    expect(source).toContain('const AUTOPILOT_QUEUE = "autopilot-plans";');
    expect(source).toContain("new Worker(AUTOPILOT_QUEUE, processAutopilotPlanJob, { connection, concurrency: 2 })");
    expect(source).toContain("autopilotCheckpointItem(item)");
    expect(source).toContain("await autopilotWorker?.close()");
  });

  it("keeps provider failure inside a short attempt budget with a fast cloud fallback", () => {
    expect(source).toContain("attemptTimeoutMs: AUTOPILOT_AI_ATTEMPT_TIMEOUT_MS");
    expect(source).toContain("overallTimeoutMs: AUTOPILOT_AI_OVERALL_TIMEOUT_MS");
    expect(source).toContain("fallbackEngines: autopilotFallbackEngines(selectedEngine)");
    expect(source).toContain("maxAttempts: 4");
    expect(source).toContain("circuitFailureThreshold: 1");
    expect(source).toContain("process.env.AUTOPILOT_SEMANTIC_ENGINE || DEFAULT_AUTOPILOT_ENGINE");
    expect(source).toContain('generationEngine === "navy-minimax-m3" ? 2 : 3');
  });

  it("rechecks full-auto eligibility while locking settings before publication", () => {
    expect(source).toMatch(/select enabled, mode, approvals_streak[\s\S]*?for update/);
    expect(source).toContain("fullAtCommit && item.autoApprove");
    expect(source).not.toContain("if (item.autoApprove && evaluation.eligible");
  });

  it("keeps a durable build heartbeat through long generation phases", () => {
    expect(source).toContain("const stopBuildHeartbeat = startAutopilotBuildHeartbeat");
    expect(source).toContain("set build_activity_at = now()");
    expect(source).toContain("await stopBuildHeartbeat()");
  });
});
