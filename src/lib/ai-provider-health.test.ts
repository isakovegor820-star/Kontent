import { describe, expect, it } from "vitest";
import { ProviderCircuitBreaker } from "./ai-provider-health";

describe("provider circuit breaker", () => {
  it("открывается после bounded серии transient failures", () => {
    const breaker = new ProviderCircuitBreaker({ failureThreshold: 3, openMs: 1_000 });
    breaker.recordFailure("openai", { code: "network_error", transient: true, latencyMs: 20 }, 100);
    breaker.recordFailure("openai", { code: "first_token_timeout", transient: true, latencyMs: 30 }, 200);
    expect(breaker.beforeRequest("openai", 250)).toMatchObject({ allowed: true, state: "closed" });
    breaker.recordFailure("openai", { code: "provider_unavailable", transient: true, latencyMs: 40 }, 300);

    expect(breaker.beforeRequest("openai", 500)).toEqual({ allowed: false, state: "open", retryAt: 1_300 });
    expect(breaker.snapshot(500)).toEqual([
      expect.objectContaining({
        engine: "openai",
        state: "open",
        consecutiveTransientFailures: 3,
        failures: 3,
        lastFailureCode: "provider_unavailable",
        lastLatencyMs: 40,
      }),
    ]);
  });

  it("разрешает только один half-open probe и закрывается после успеха", () => {
    const breaker = new ProviderCircuitBreaker({ failureThreshold: 1, openMs: 1_000 });
    breaker.recordFailure("claude", { code: "overall_timeout", transient: true, latencyMs: 100 }, 100);

    expect(breaker.snapshot(1_100)[0].state).toBe("half_open");
    expect(breaker.beforeRequest("claude", 1_100)).toMatchObject({ allowed: true, state: "half_open" });
    expect(breaker.beforeRequest("claude", 1_101)).toMatchObject({ allowed: false, state: "half_open" });
    breaker.recordSuccess("claude", 55, 1_200);
    expect(breaker.snapshot(1_200)[0]).toMatchObject({
      state: "closed",
      consecutiveTransientFailures: 0,
      successes: 1,
      lastOutcome: "success",
      retryAt: null,
    });
  });

  it("не считает validation/4xx и отмену пользователя provider outage", () => {
    const breaker = new ProviderCircuitBreaker({ failureThreshold: 1 });
    breaker.recordFailure("gemini", { code: "bad_request", transient: false, latencyMs: 10 }, 100);
    expect(breaker.snapshot(100)[0]).toMatchObject({ state: "closed", consecutiveTransientFailures: 0 });
    breaker.recordCancellation("gemini", 200);
    expect(breaker.snapshot(200)[0]).toMatchObject({
      state: "closed",
      consecutiveTransientFailures: 0,
      lastOutcome: "cancelled",
    });
  });

  it("экспортирует bounded snapshot без endpoint, key, prompt и сырого сообщения", () => {
    const breaker = new ProviderCircuitBreaker({ failureThreshold: 1, maxEntries: 2 });
    breaker.recordFailure("openai", {
      code: "Bearer secret user prompt",
      transient: true,
      latencyMs: 10,
    }, 100);
    breaker.recordSuccess("claude", 20, 200);
    breaker.recordSuccess("gemini", 30, 300);

    const snapshot = breaker.snapshot(300);
    expect(snapshot).toHaveLength(2);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("http");
    expect(Object.keys(snapshot[0])).toEqual([
      "engine",
      "state",
      "consecutiveTransientFailures",
      "successes",
      "failures",
      "lastOutcome",
      "lastFailureCode",
      "lastLatencyMs",
      "updatedAt",
      "retryAt",
    ]);
  });
});
