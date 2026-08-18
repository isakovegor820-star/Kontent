import { describe, expect, it } from "vitest";
import { autopilotBuildTimeoutMs, isAutopilotBuildStale } from "./autopilot-build";

describe("autopilot build deadline", () => {
  it("allows five minutes without a durable checkpoint", () => {
    expect(autopilotBuildTimeoutMs(5)).toBe(5 * 60_000);
  });

  it("grows for large plans but is capped", () => {
    expect(autopilotBuildTimeoutMs(20)).toBe(15 * 60_000);
    expect(autopilotBuildTimeoutMs(30)).toBe(15 * 60_000);
    expect(autopilotBuildTimeoutMs(999)).toBe(15 * 60_000);
  });

  it("marks only expired builds as stale", () => {
    const now = Date.parse("2026-07-29T12:00:00.000Z");
    expect(isAutopilotBuildStale("2026-07-29T11:55:01.000Z", 5, now)).toBe(false);
    expect(isAutopilotBuildStale("2026-07-29T11:55:00.000Z", 5, now)).toBe(true);
  });
});
