import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiProviderCircuitBreaker } from "./ai-provider-health";
import { probeAiProviderReadiness } from "./readiness-probes";

const engine = "navy-deepseek-flash";
beforeEach(() => {
  vi.stubEnv("NAVYAI_API_KEY", "synthetic-readiness-key");
  vi.stubEnv("NAVYAI_API_URL", "https://navy.example/v1");
  vi.stubEnv("AI_SERVICE_ENGINE", engine);
  aiProviderCircuitBreaker.reset();
});
afterEach(() => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers();
  aiProviderCircuitBreaker.reset();
});

describe("readiness preserves execution evidence without unmetered provider calls", () => {
  it.each([410, 200])("a cold check never purchases a completion even if the provider would return %s", async status => {
    const fetcher = vi.fn(async () => status === 200
      ? Response.json({ choices: [{ message: { content: "READY" }, finish_reason: "stop" }] })
      : new Response("", { status }));
    vi.stubGlobal("fetch", fetcher);
    expect(await probeAiProviderReadiness()).toEqual([]);
    expect(aiProviderCircuitBreaker.snapshot()).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not refresh stale success or hide a recorded provider failure", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-07T00:00:00Z"));
    const fetcher = vi.fn(async () => new Response("unexpected", { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    aiProviderCircuitBreaker.recordSuccess(engine, 5, Date.now() - 16 * 60_000);
    const stale = aiProviderCircuitBreaker.snapshot();
    expect(await probeAiProviderReadiness()).toEqual(stale);
    aiProviderCircuitBreaker.recordFailure(engine, { code: "provider_unavailable", transient: true, latencyMs: 10 });
    const failed = aiProviderCircuitBreaker.snapshot();
    expect(await probeAiProviderReadiness()).toEqual(failed);
    expect(failed[0]).toMatchObject({ lastOutcome: "failure", successes: 1, failures: 1 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("concurrent cold checks remain unknown, then observe a normal recorded operation", async () => {
    const fetcher = vi.fn(async () => Response.json({ choices: [{ message: { content: "READY" }, finish_reason: "stop" }] }));
    vi.stubGlobal("fetch", fetcher);
    const cold = await Promise.all(Array.from({ length: 20 }, () => probeAiProviderReadiness()));
    expect(cold).toEqual(Array.from({ length: 20 }, () => []));
    aiProviderCircuitBreaker.recordSuccess(engine, 5);
    const observed = aiProviderCircuitBreaker.snapshot();
    expect(await probeAiProviderReadiness()).toEqual(observed);
    expect(observed[0]).toMatchObject({ engine, lastOutcome: "success", successes: 1 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
