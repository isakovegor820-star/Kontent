import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const worker = readFileSync(new URL("../worker.mjs", import.meta.url), "utf8");

describe("Autopilot build queue runtime reconciliation", () => {
  it("reconciles durable building plans on startup and periodically", () => {
    expect(worker).toContain("reconcileBuildingAutopilotPlans");
    expect(worker).toContain("await reconcileAutopilotBuildQueue().catch");
    expect(worker).toContain("const autopilotBuildQueueTimer = setInterval");
    expect(worker).toContain("autopilotBuildQueueTimer.unref()");
  });

  it("does not read a charged quota reservation as a delivered plan", () => {
    // The reservation key is deterministic per plan, so an attempt that charged quota and
    // then died before writing a result made every later replay return early. The job
    // completed, `removeOnComplete` deleted it, and the plan stayed `building` with nothing
    // queued and no failure — while reconciliation repeated that no-op every 30 s. Two
    // production plans sat like that for eight days. `building` must win over the
    // reservation, and the resumed build must reuse the reservation already paid for.
    expect(worker).not.toContain(
      'if (usage.state === "committed") return { ok: true, replayed: true, planId };',
    );
    expect(worker).toMatch(
      /if \(usage\.state === "committed"\) \{[\s\S]*?status = 'building'[\s\S]*?if \(!unfinished\.rowCount\) return \{ ok: true, replayed: true, planId \};/,
    );
    // The build continues on the same reservation id, so a resume cannot charge twice.
    expect(worker).toContain("const stopHeartbeat = startAiUsageHeartbeat(userId, usage.reservationId);");
  });
});
