import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveEngineRuntime } from "./ai-provider";
import { aiProviderCircuitBreaker } from "./ai-provider-health";
import { probeAiProviderReadiness } from "./readiness-probes";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); aiProviderCircuitBreaker.reset(); });
describe("readiness observes execution without issuing an unbudgeted generation", () => {
  it("does not turn an available catalogue into execution health", async () => {
    vi.stubEnv("AI_SERVICE_ENGINE", "openai"); vi.stubEnv("OPENAI_API_KEY", "synthetic-readiness-key");
    const model = resolveEngineRuntime("openai").model;
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith("/models")
      ? Response.json({ data: [{ id: model }] }) : new Response("", { status: 410 }));
    vi.stubGlobal("fetch", fetcher);
    expect(await probeAiProviderReadiness()).toEqual([]);
    expect(aiProviderCircuitBreaker.snapshot()).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["success", "failure"])("preserves actual %s evidence from the selected engine", async outcome => {
    vi.stubEnv("AI_SERVICE_ENGINE", "openai"); vi.stubEnv("OPENAI_API_KEY", "synthetic-readiness-key");
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    aiProviderCircuitBreaker.recordSuccess("local", 1);
    if (outcome === "success") aiProviderCircuitBreaker.recordSuccess("openai", 5);
    else aiProviderCircuitBreaker.recordFailure("openai", { code: "provider_unavailable", transient: true, latencyMs: 5 });
    expect(await probeAiProviderReadiness()).toEqual([expect.objectContaining({ engine: "openai", lastOutcome: outcome })]);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
