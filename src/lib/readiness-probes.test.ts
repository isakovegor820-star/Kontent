import { afterEach, describe, expect, it, vi } from "vitest";
import { aiProviderCircuitBreaker, ProviderCircuitBreaker } from "./ai-provider-health";
import {
  probeAiProviderReadiness,
  probeMailDeliveryConfiguration,
  probeTrackingSecretsConfiguration,
} from "./readiness-probes";

describe("AI provider readiness probe", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); aiProviderCircuitBreaker.reset(); });

  it("does not claim real default Claude configuration as observed provider success", async () => {
    aiProviderCircuitBreaker.reset();
    vi.stubEnv("AI_SERVICE_ENGINE", "claude");
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-readiness-test-key");
    const fetch = vi.fn(async () => { throw new Error("unexpected_provider_request"); });
    vi.stubGlobal("fetch", fetch);
    expect(await probeAiProviderReadiness()).toEqual([]);
    expect(aiProviderCircuitBreaker.snapshot()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("establishes bounded provider evidence after a fresh web-process restart", async () => {
    const breaker = new ProviderCircuitBreaker();
    const ready = vi.fn(async () => true);

    const providers = await probeAiProviderReadiness({
      configured: () => true,
      engine: () => "openai",
      ready,
      snapshot: () => breaker.snapshot(1_100),
      recordSuccess: (engine, latencyMs) => breaker.recordSuccess(engine, latencyMs, 1_100),
      recordFailure: (engine, input) => breaker.recordFailure(engine, input, 1_100),
      now: vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_100),
    });

    expect(ready).toHaveBeenCalledOnce();
    expect(providers).toEqual([
      expect.objectContaining({
        engine: "openai",
        state: "closed",
        lastOutcome: "success",
        lastLatencyMs: 100,
      }),
    ]);
  });

  it("keeps a failed cold-start capability probe blocked", async () => {
    const breaker = new ProviderCircuitBreaker();

    const providers = await probeAiProviderReadiness({
      configured: () => true,
      engine: () => "openai",
      ready: async () => false,
      snapshot: () => breaker.snapshot(1_100),
      recordSuccess: (engine, latencyMs) => breaker.recordSuccess(engine, latencyMs, 1_100),
      recordFailure: (engine, input) => breaker.recordFailure(engine, input, 1_100),
      now: vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_100),
    });

    expect(providers).toEqual([
      expect.objectContaining({
        engine: "openai",
        lastOutcome: "failure",
        lastFailureCode: "readiness_probe_failed",
      }),
    ]);
  });

  it("does not overwrite existing runtime failure evidence with a health probe", async () => {
    const breaker = new ProviderCircuitBreaker();
    breaker.recordFailure("openai", {
      code: "provider_unavailable",
      transient: true,
      latencyMs: 75,
    }, 900);
    const ready = vi.fn(async () => true);

    const providers = await probeAiProviderReadiness({
      configured: () => true,
      engine: () => "openai",
      ready,
      snapshot: () => breaker.snapshot(1_100),
      recordSuccess: (engine, latencyMs) => breaker.recordSuccess(engine, latencyMs, 1_100),
      recordFailure: (engine, input) => breaker.recordFailure(engine, input, 1_100),
      now: () => 1_100,
    });

    expect(ready).not.toHaveBeenCalled();
    expect(providers).toEqual([
      expect.objectContaining({
        lastOutcome: "failure",
        lastFailureCode: "provider_unavailable",
      }),
    ]);
  });
  it("rechecks an expired failure and confirms recovery without resetting historical counters", async () => {
    const breaker = new ProviderCircuitBreaker();
    breaker.recordFailure("openai", { code: "readiness_probe_failed", transient: true, latencyMs: 10 }, 1000);
    const now = 1000 + 15 * 60_000;
    const ready = vi.fn(async () => true);
    const providers = await probeAiProviderReadiness({ configured: () => true, engine: () => "openai", ready,
      snapshot: () => breaker.snapshot(now), now: () => now,
      recordSuccess: (engine, latency) => breaker.recordSuccess(engine, latency, now),
      recordFailure: (engine, input) => breaker.recordFailure(engine, input, now),
    });
    expect(ready).toHaveBeenCalledOnce();
    expect(providers[0]).toMatchObject({ lastOutcome: "success", failures: 1, successes: 1, updatedAt: new Date(now).toISOString() });
  });
  it("does not reuse an old successful capability check when the provider now fails", async () => {
    const breaker = new ProviderCircuitBreaker();
    breaker.recordSuccess("openai", 10, 1000);
    const now = 1000 + 15 * 60_000;
    const providers = await probeAiProviderReadiness({ configured: () => true, engine: () => "openai", ready: async () => false,
      snapshot: () => breaker.snapshot(now), now: () => now,
      recordSuccess: (engine, latency) => breaker.recordSuccess(engine, latency, now),
      recordFailure: (engine, input) => breaker.recordFailure(engine, input, now),
    });
    expect(providers[0]).toMatchObject({ lastOutcome: "failure", failures: 1, successes: 1 });
  });
  it("checks the selected engine even when another engine has a fresh success", async () => {
    const breaker = new ProviderCircuitBreaker();
    breaker.recordSuccess("local", 5, 1000);
    const ready = vi.fn(async () => false);
    const providers = await probeAiProviderReadiness({
      configured: () => true, engine: () => "openai", ready,
      snapshot: () => breaker.snapshot(1100), now: () => 1100,
      recordSuccess: (engine, latency) => breaker.recordSuccess(engine, latency, 1100),
      recordFailure: (engine, input) => breaker.recordFailure(engine, input, 1100),
    });
    expect(ready).toHaveBeenCalledExactlyOnceWith("openai");
    expect(providers).toEqual([expect.objectContaining({ engine: "openai", lastOutcome: "failure" })]);
    expect(breaker.snapshot(1100)).toHaveLength(2);
  });

  it("preserves a real runtime failure that arrives while a stale capability probe is in flight", async () => {
    const breaker = new ProviderCircuitBreaker();
    breaker.recordSuccess("openai", 5, 1000);
    const now = 1000 + 15 * 60_000;
    let finishProbe!: (value: boolean) => void;
    const pending = probeAiProviderReadiness({
      configured: () => true, engine: () => "openai",
      ready: () => new Promise<boolean>((resolve) => { finishProbe = resolve; }),
      snapshot: () => breaker.snapshot(now), now: () => now,
      recordSuccess: (engine, latency) => breaker.recordSuccess(engine, latency, now),
      recordFailure: (engine, input) => breaker.recordFailure(engine, input, now),
    });
    breaker.recordFailure("openai", { code: "provider_unavailable", transient: true, latencyMs: 20 }, now);
    finishProbe?.(true);
    expect(await pending).toEqual([expect.objectContaining({
      lastOutcome: "failure", lastFailureCode: "provider_unavailable", failures: 1, successes: 1,
    })]);
  });

  it("does not record configuration-only readiness as provider success", async () => {
    const ready = vi.fn(async () => true);
    const success = vi.fn();
    expect(await probeAiProviderReadiness({ configured: () => true, engine: () => "openai", canProbe: () => false,
      ready, snapshot: () => [], recordSuccess: success, recordFailure: vi.fn(), now: Date.now,
    })).toEqual([]);
    expect(ready).not.toHaveBeenCalled(); expect(success).not.toHaveBeenCalled();
  });
});

describe("password recovery readiness configuration", () => {
  const configured = {
    NODE_ENV: "production",
    APP_URL: "https://aurora.example",
    RESEND_API_KEY: "provider-key",
    PASSWORD_RESET_FROM: "security@example.test",
    TOKENS_MASTER_KEY: "envelope-key",
  } as NodeJS.ProcessEnv;

  it("requires public URL, provider, sender and durable token-envelope key", () => {
    expect(probeMailDeliveryConfiguration(configured)).toBe("up");
    expect(probeMailDeliveryConfiguration({ ...configured, APP_URL: "" })).toBe("not_configured");
    expect(probeMailDeliveryConfiguration({ ...configured, RESEND_API_KEY: "" })).toBe("not_configured");
    expect(probeMailDeliveryConfiguration({ ...configured, PASSWORD_RESET_FROM: "" })).toBe("not_configured");
    expect(probeMailDeliveryConfiguration({ ...configured, TOKENS_MASTER_KEY: "" })).toBe("not_configured");
    expect(probeMailDeliveryConfiguration({ ...configured, APP_URL: "http://aurora.example" })).toBe("not_configured");
  });
});

describe("tracking secrets readiness configuration", () => {
  it("requires two different secrets with at least 32 characters", () => {
    const configured = {
      NODE_ENV: "test",
      TRACKING_ATTRIBUTION_SECRET: "a".repeat(48),
      TRACKING_FINGERPRINT_SECRET: "b".repeat(48),
    } as NodeJS.ProcessEnv;
    expect(probeTrackingSecretsConfiguration(configured)).toBe("up");
    expect(probeTrackingSecretsConfiguration({ NODE_ENV: "test" })).toBe("not_configured");
    expect(probeTrackingSecretsConfiguration({
      ...configured,
      TRACKING_FINGERPRINT_SECRET: "short",
    })).toBe("down");
    expect(probeTrackingSecretsConfiguration({
      ...configured,
      TRACKING_FINGERPRINT_SECRET: configured.TRACKING_ATTRIBUTION_SECRET,
    })).toBe("down");
  });
});
