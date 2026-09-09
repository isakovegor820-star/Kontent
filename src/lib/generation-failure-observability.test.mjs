import { describe, expect, it, vi } from "vitest";
import { generationFailureEvent, reportGenerationFailure } from "./generation-failure-observability.mjs";

describe("generation failure observability", () => {
  it("reports a stable failure group and safe request correlation only", () => {
    const input = {
      surface: "text", code: "empty_generation", engine: "navy-qwen-3-6",
      requestId: "11111111-1111-4111-8111-111111111111", status: 502,
      prompt: "PRIVATE PROMPT", response: "PRIVATE RESPONSE", token: "secret-key",
    };
    const event = generationFailureEvent(input);
    expect(event.tags).toMatchObject({ code: "empty_generation", surface: "text" });
    expect(event.extra).toEqual({ requestId: input.requestId, httpStatus: 502 });
    expect(JSON.stringify(event)).not.toMatch(/PRIVATE|secret-key/u);
    const report = vi.fn();
    reportGenerationFailure(input, report);
    expect(report).toHaveBeenCalledExactlyOnceWith(event);
  });

  it("rejects raw messages in labels and never interrupts generation recovery", () => {
    const input = { surface: "media", code: "Bearer private-secret", requestId: "user@example.com" };
    expect(generationFailureEvent(input).extra).toEqual({});
    expect(JSON.stringify(generationFailureEvent(input))).not.toMatch(/private-secret|example.com/u);
    expect(() => reportGenerationFailure(input, () => { throw Error("reporter unavailable"); })).not.toThrow();
  });
});
