import { describe, expect, it, vi } from "vitest";

import {
  buildOperationalSignal,
  emitOperationalSignal,
  OPERATIONAL_SIGNAL_EVENTS,
} from "./operational-signal.mjs";

describe("operational signals", () => {
  it("emits one machine-parseable line without arbitrary fields", () => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    const signal = emitOperationalSignal({
      event: OPERATIONAL_SIGNAL_EVENTS.deliveryUnknown,
      surface: "web",
      projectId: 41,
      entityId: 73,
      token: "must-not-leak",
    }, { logger, now: new Date("2026-08-17T10:00:00.000Z") });

    expect(logger.error).toHaveBeenCalledOnce();
    const line = logger.error.mock.calls[0][0];
    expect(line).toMatch(/^\[operational_signal\] \{/u);
    expect(JSON.parse(line.slice(line.indexOf("{") ))).toEqual(signal);
    expect(line).not.toContain("must-not-leak");
  });

  it("assigns stable severity and sanitizes labels", () => {
    expect(buildOperationalSignal({
      event: OPERATIONAL_SIGNAL_EVENTS.uploadBusy,
      requestId: "BAD VALUE WITH SPACES",
      retryAfterSeconds: 2,
    }, new Date("2026-08-17T10:00:00.000Z"))).toMatchObject({
      severity: "warning",
      component: "media_upload",
      requestId: "invalid_label",
      retryAfterSeconds: 2,
    });
  });

  it("rejects unknown event names", () => {
    expect(() => buildOperationalSignal({ event: "anything" }))
      .toThrowError("unsupported_operational_signal");
  });
});
