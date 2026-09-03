import { afterEach, describe, expect, it, vi } from "vitest";

import {
  auroraProductEventWireDraft,
  auroraSectionForPath,
  emitAuroraProductEvent,
  installAuroraTelemetrySink,
  primaryAuroraFeature,
} from "./aurora-product-telemetry";

describe("Aurora product telemetry", () => {
  afterEach(() => installAuroraTelemetrySink(null));

  it("maps all public section paths and aliases to the 16-section catalog", () => {
    expect(auroraSectionForPath("/app/sites")).toBe("sites");
    expect(auroraSectionForPath("/app/site-analysis/41")).toBe("siteAnalysis");
    expect(auroraSectionForPath("/app/today")).toBe("today");
    expect(auroraSectionForPath("/app/studio/visuals")).toBe("studio");
    expect(auroraSectionForPath("/app/competitors/3")).toBe("recon");
    expect(auroraSectionForPath("/app/trends")).toBe("recon");
    expect(auroraSectionForPath("/app/onboarding")).toBeNull();
    expect(primaryAuroraFeature("siteAnalysis")).toBe("analysis");
  });

  it("validates before sending and never forwards arbitrary actions or metadata", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "123e4567-e89b-42d3-a456-426614174000" });
    const sink = vi.fn();
    installAuroraTelemetrySink(sink);
    expect(emitAuroraProductEvent({
      sectionId: "studio", featureId: "generation", action: "requested", stage: "started", outcome: "pending",
      durationMs: null, errorCode: null, requestId: null, operationId: null, sessionId: null,
      safeContext: { device: "desktop", source: "ui", operationKind: "user_action" },
    })).toBe(true);
    expect(emitAuroraProductEvent({
      sectionId: "studio", featureId: "generation", action: "arbitrary_action", stage: "started", outcome: "pending",
      durationMs: null, errorCode: null, requestId: null, operationId: null, sessionId: null,
      safeContext: { device: "desktop", source: "ui", operationKind: "user_action" },
    } as never)).toBe(false);
    expect(sink).toHaveBeenCalledTimes(1);
    const queuedEvent = sink.mock.calls[0][0];
    expect(queuedEvent).toMatchObject({ important: false });
    expect(auroraProductEventWireDraft(queuedEvent)).not.toHaveProperty("important");
  });
});
