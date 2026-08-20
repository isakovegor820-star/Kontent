import { describe, expect, it, vi } from "vitest";
import { ProviderCircuitBreaker } from "./ai-provider-health";
import {
  probeAiProviderReadiness,
  probeMailDeliveryConfiguration,
  probeTrackingSecretsConfiguration,
} from "./readiness-probes";

describe("AI provider readiness probe", () => {
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
