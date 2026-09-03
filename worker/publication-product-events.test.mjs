import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const worker = readFileSync(new URL("../worker.mjs", import.meta.url), "utf8");
const publishJob = worker.slice(worker.indexOf('new Worker(\n  "publish"'), worker.indexOf("const publicationHeartbeatEnabled"));

describe("publication worker product events", () => {
  it("records every terminal publication outcome through the shared server emitter", () => {
    expect(worker).toContain('from "./src/lib/server-product-events.mjs"');
    const outcomes = [...publishJob.matchAll(/recordPublicationOutcome\(\{[\s\S]*?\}\);/gu)].map((match) => match[0]);
    // blocked provider, disconnected channel, auth failure, delivery unknown, success, retry, final failure
    expect(outcomes).toHaveLength(7);
    expect(outcomes.filter((call) => call.includes('stage: "completed", outcome: "success"'))).toHaveLength(1);
    expect(outcomes.filter((call) => call.includes('stage: "completed", outcome: "pending"'))).toHaveLength(1);
    expect(outcomes.filter((call) => call.includes('stage: "retried"'))).toHaveLength(1);
    expect(outcomes.filter((call) => call.includes('stage: "failed", outcome: "failure"'))).toHaveLength(4);
    for (const call of outcomes) {
      expect(call).toContain("startedAt: jobStartedAt");
      expect(call).toContain("attempt:");
    }
  });

  it("never passes provider text or reasons into telemetry", () => {
    const helper = worker.slice(worker.indexOf("function recordPublicationOutcome("), worker.indexOf("const worker = AUTOPILOT_ONLY"));
    expect(helper).toContain('sectionId: "calendar"');
    expect(helper).toContain('source: "worker"');
    expect(helper).not.toMatch(/reason|last_error|\.text/u);
    for (const call of publishJob.matchAll(/recordPublicationOutcome\(\{[\s\S]*?\}\);/gu)) {
      expect(call[0]).not.toMatch(/reason|post\.text|description/u);
      if (call[0].includes("errorCode")) expect(call[0]).toMatch(/errorCode: (safeProductErrorCode\(|")/u);
    }
  });
});
