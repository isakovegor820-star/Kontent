import { describe, expect, it } from "vitest";
import { diagnosticDisplayState, isSystemDiagnostics } from "./admin-system-freshness";

describe("diagnostic freshness", () => {
  const checkedAt = "2026-09-05T12:00:00.000Z";
  const now = Date.parse(checkedAt);
  it("expires a healthy heartbeat at its real TTL", () => {
    const component = { state: "healthy" as const, checkedAt, validUntil: new Date(now + 30_000).toISOString() };
    expect(diagnosticDisplayState(component, now + 29_999)).toBe("healthy");
    expect(diagnosticDisplayState(component, now + 30_000)).toBe("stale");
    expect(diagnosticDisplayState(component, now + 1, true)).toBe("unavailable");
  });
  it("does not accept absent or future evidence", () => {
    expect(diagnosticDisplayState({ state: "healthy", checkedAt: "bad" }, now)).toBe("unavailable");
    expect(diagnosticDisplayState({ state: "healthy", checkedAt }, now - 60_000)).toBe("unavailable");
    expect(isSystemDiagnostics({ components: [] })).toBe(false);
    expect(isSystemDiagnostics(null)).toBe(false);
  });
  it("recovers on a fresh result without changing the previous snapshot", () => {
    const old = { state: "healthy" as const, checkedAt };
    expect(diagnosticDisplayState(old, now + 61_000)).toBe("stale");
    expect(diagnosticDisplayState({ ...old, checkedAt: new Date(now + 61_000).toISOString() }, now + 61_001)).toBe("healthy");
    expect(old.checkedAt).toBe(checkedAt);
  });
});
