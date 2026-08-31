import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AiCompletionError,
  completeAiText,
  resetAiCompletionCircuits,
} from "./ai-completion-service.mjs";
import { configuredAiConcurrency, configuredServiceEngine } from "./ai-engine-policy.mjs";
import { autopilotFallbackEngines } from "./autopilot-config.mjs";

const request = { system: "SYSTEM", user: "USER", temperature: 0.2, maxTokens: 300 };

describe("shared direct/background AI completion service", () => {
  beforeEach(resetAiCompletionCircuits);

  it("keeps cloud plan concurrency even when local Ollama is the last fallback", () => {
    const env = {
      NAVYAI_API_KEY: "secret",
      AI_FALLBACK_ENGINES: "navy-deepseek-flash,local",
    };

    expect(configuredAiConcurrency("navy-deepseek-pro", env)).toBe(3);
    expect(configuredAiConcurrency("navy-deepseek-pro", {
      ...env,
      AI_FALLBACK_ENGINES: "navy-deepseek-flash",
    })).toBe(3);
    expect(configuredAiConcurrency("local", env)).toBe(1);
  });

  it("selects NavyAI for every unpinned service surface when it is the configured engine", async () => {
    const env = { NAVYAI_API_KEY: "secret", NAVYAI_API_URL: "https://navy.example/v1" };
    const fetchImpl = vi.fn(async () => Response.json({
      choices: [{ message: { content: "DONE" }, finish_reason: "stop" }],
    }));
    // An unpinned surface must land on a route that answers. GPT-5.4 held this slot while
    // returning HTTP 500 for every Autopilot request, so no unpinned plan could generate.
    expect(configuredServiceEngine(null, env)).toBe("navy-deepseek-flash");
    const result = await completeAiText(request, { env, fetchImpl });

    expect(result).toMatchObject({
      text: "DONE",
      engine: "navy-deepseek-flash",
      fallbackUsed: false,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://navy.example/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      model: "deepseek-v4-flash",
      max_tokens: 3_000,
    });
  });

  it("passes a stable provider idempotency key and correlation ID", async () => {
    const env = { NAVYAI_API_KEY: "secret", NAVYAI_API_URL: "https://navy.example/v1" };
    const fetchImpl = vi.fn(async () => Response.json({
      choices: [{ message: { content: "DONE" }, finish_reason: "stop" }],
    }));
    await completeAiText({
      ...request,
      providerRequestKey: "a".repeat(64),
      providerRequestId: "req-site-analysis-41",
    }, { env, fetchImpl, allowFallback: false });
    const headers = new Headers(fetchImpl.mock.calls[0][1].headers);
    expect(headers.get("idempotency-key")).toBe("a".repeat(64));
    expect(headers.get("x-request-id")).toBe("req-site-analysis-41");
  });

  it("gives every Navy engine room for hidden reasoning plus a visible answer", async () => {
    // MiniMax and Qwen do not accept `reasoning_effort: "none"`, so a small budget was spent
    // on reasoning and `content` came back empty. Autopilot read that as `empty_generation`
    // on every draft until each engine's circuit opened and the fleet answered
    // `provider_unavailable`.
    const fetchImpl = vi.fn(async () => Response.json({
      choices: [{ message: { content: "DONE" }, finish_reason: "stop" }],
    }));
    await completeAiText({ ...request, engine: "navy-minimax-m3", maxTokens: 60 }, {
      env: { NAVYAI_API_KEY: "secret", NAVYAI_API_URL: "https://navy.example/v1" },
      fetchImpl,
      allowFallback: false,
    });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toMatchObject({ model: "minimax-m3", max_tokens: 3_000 });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("uses a surface-specific fallback fleet instead of an unhealthy local override", async () => {
    const env = {
      NAVYAI_API_KEY: "secret",
      AI_FALLBACK_ENGINES: "local",
      AI_FALLBACK_STRICT: "1",
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: "FAST FALLBACK" }, finish_reason: "stop" }],
      }));

    await expect(completeAiText({ ...request, engine: "navy-gpt-5-4" }, {
      env,
      fetchImpl,
      fallbackEngines: ["navy-minimax-m3"],
      circuitFailureThreshold: 20,
    })).resolves.toMatchObject({ engine: "navy-minimax-m3", text: "FAST FALLBACK" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toContain("api.navy");
  });

  it("reserves overall time for a fallback after the primary attempt times out", async () => {
    const env = { NAVYAI_API_KEY: "secret" };
    const fetchImpl = vi.fn((_url, init) => {
      if (fetchImpl.mock.calls.length === 1) {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        });
      }
      return Promise.resolve(Response.json({
        choices: [{ message: { content: "RECOVERED" }, finish_reason: "stop" }],
      }));
    });

    await expect(completeAiText({ ...request, engine: "navy-gpt-5-4" }, {
      env,
      fetchImpl,
      fallbackEngines: ["navy-minimax-m3"],
      timeoutMs: 100,
      overallTimeoutMs: 500,
      circuitFailureThreshold: 20,
    })).resolves.toMatchObject({ engine: "navy-minimax-m3", text: "RECOVERED" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("recovers an Autopilot call by jumping to Flash instead of waiting on MiniMax", async () => {
    const env = { NAVYAI_API_KEY: "secret" };
    const fetchImpl = vi.fn((_url, init) => {
      const model = JSON.parse(init.body).model;
      if (model === "gpt-5.4") {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        });
      }
      return Promise.resolve(Response.json({
        choices: [{ message: { content: "Разбор :: Проверка оферты" }, finish_reason: "stop" }],
      }));
    });

    await expect(completeAiText({ ...request, engine: "navy-gpt-5-4" }, {
      env,
      fetchImpl,
      timeoutMs: 80,
      overallTimeoutMs: 400,
      maxAttempts: 4,
      circuitFailureThreshold: 20,
      fallbackEngines: autopilotFallbackEngines("navy-gpt-5-4"),
    })).resolves.toMatchObject({
      engine: "navy-deepseek-flash",
      text: "Разбор :: Проверка оферты",
      fallbackUsed: true,
    });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).model).toBe("deepseek-v4-flash");
  });

  it("can disable provider fallback for one evidence-sensitive request", async () => {
    const env = {
      NAVYAI_API_KEY: "secret",
      NAVYAI_API_URL: "https://navy.example/v1",
      AI_FALLBACK_ENGINES: "navy-deepseek-flash",
    };
    const fetchImpl = vi.fn(async () => new Response("unavailable", { status: 503 }));
    await expect(completeAiText(request, {
      env,
      fetchImpl,
      allowFallback: false,
      circuitFailureThreshold: 20,
    }))
      .rejects.toMatchObject({ code: "provider_error", status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses the same explicit fallback policy and does not splice a partial response", async () => {
    const env = {
      NAVYAI_API_KEY: "secret",
      NAVYAI_API_URL: "https://navy.example/v1",
      AI_FALLBACK_ENGINES: "navy-deepseek-flash",
    };
    const telemetry = vi.fn();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: "FALLBACK" }, finish_reason: "stop" }],
      }));

    const result = await completeAiText({ ...request, engine: "navy-deepseek-pro" }, {
      env,
      fetchImpl,
      telemetry,
    });
    expect(result).toMatchObject({ text: "FALLBACK", engine: "navy-deepseek-flash", fallbackUsed: true, attempts: 2 });
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({ type: "fallback" }));
  });

  it("opens a circuit after repeated provider failure and skips the broken model", async () => {
    const env = {
      NAVYAI_API_KEY: "secret",
      AI_FALLBACK_ENGINES: "navy-minimax-m3",
      AI_FALLBACK_STRICT: "1",
    };
    const firstFetch = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: "FALLBACK" }, finish_reason: "stop" }],
      }));
    await completeAiText({ ...request, engine: "navy-deepseek-flash" }, {
      env,
      fetchImpl: firstFetch,
      circuitFailureThreshold: 1,
      circuitOpenMs: 30_000,
    });

    const telemetry = vi.fn();
    const secondFetch = vi.fn(async () => Response.json({
      choices: [{ message: { content: "HEALTHY" }, finish_reason: "stop" }],
    }));
    const result = await completeAiText({ ...request, engine: "navy-deepseek-flash" }, {
      env,
      fetchImpl: secondFetch,
      telemetry,
      circuitFailureThreshold: 1,
      circuitOpenMs: 30_000,
    });

    expect(result).toMatchObject({ engine: "navy-minimax-m3", attempts: 1, fallbackUsed: true });
    expect(secondFetch).toHaveBeenCalledTimes(1);
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
      engine: "navy-deepseek-flash",
      outcome: "skipped",
      code: "circuit_open",
    }));
  });

  it("stops all fallbacks at the overall deadline", async () => {
    const fetchImpl = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }));
    await expect(completeAiText({ ...request, engine: "openai" }, {
      env: { OPENAI_API_KEY: "secret" },
      fetchImpl,
      timeoutMs: 1_000,
      overallTimeoutMs: 100,
      circuitFailureThreshold: 20,
    })).rejects.toMatchObject({ code: "overall_timeout", status: 504 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not blame an engine for the caller's own overall deadline", async () => {
    // Autopilot builds several posts concurrently against one process-global circuit map and
    // gives each build one overall budget. Charging `overall_timeout` to whichever engine was
    // in flight meant one slow build wrote a failure per concurrent post against the same
    // healthy engine, hit the threshold at once and opened its circuit. Later posts skipped
    // it as `circuit_open`, the fleet ran out of candidates, and the plan failed
    // `ai_unavailable` while the route was fine.
    const hang = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }));
    for (let concurrentPost = 0; concurrentPost < 3; concurrentPost++) {
      await expect(completeAiText({ ...request, engine: "navy-deepseek-flash" }, {
        env: { NAVYAI_API_KEY: "secret" },
        fetchImpl: hang,
        allowFallback: false,
        timeoutMs: 1_000,
        overallTimeoutMs: 50,
        circuitFailureThreshold: 1,
        circuitOpenMs: 30_000,
      })).rejects.toMatchObject({ code: "overall_timeout" });
    }

    const telemetry = vi.fn();
    const fetchImpl = vi.fn(async () => Response.json({
      choices: [{ message: { content: "READY" }, finish_reason: "stop" }],
    }));
    await expect(completeAiText({ ...request, engine: "navy-deepseek-flash" }, {
      env: { NAVYAI_API_KEY: "secret" },
      fetchImpl,
      telemetry,
      circuitFailureThreshold: 1,
      circuitOpenMs: 30_000,
    })).resolves.toMatchObject({ engine: "navy-deepseek-flash", text: "READY" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(telemetry).not.toHaveBeenCalledWith(expect.objectContaining({ code: "circuit_open" }));
  });

  it("still opens a circuit when the engine itself times out an attempt", async () => {
    // The counterpart to the case above: `provider_timeout` is this engine failing to answer
    // inside its own attempt budget, which is exactly the evidence the breaker exists for.
    const hang = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }));
    await expect(completeAiText({ ...request, engine: "navy-deepseek-flash" }, {
      env: { NAVYAI_API_KEY: "secret" },
      fetchImpl: hang,
      allowFallback: false,
      timeoutMs: 40,
      overallTimeoutMs: 5_000,
      circuitFailureThreshold: 1,
      circuitOpenMs: 30_000,
    })).rejects.toMatchObject({ code: "provider_timeout" });

    const telemetry = vi.fn();
    await expect(completeAiText({ ...request, engine: "navy-deepseek-flash" }, {
      env: { NAVYAI_API_KEY: "secret" },
      fetchImpl: vi.fn(async () => Response.json({
        choices: [{ message: { content: "READY" }, finish_reason: "stop" }],
      })),
      telemetry,
      allowFallback: false,
      circuitFailureThreshold: 1,
      circuitOpenMs: 30_000,
    })).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({ code: "circuit_open" }));
  });

  it("falls back when a background plan contains only an internal think block", async () => {
    const env = {
      NAVYAI_API_KEY: "secret",
      NAVYAI_API_URL: "https://navy.example/v1",
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: "<think>private planning" }, finish_reason: "stop" }],
      }))
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: "ГОТОВЫЙ НЕДЕЛЬНЫЙ ПЛАН" }, finish_reason: "stop" }],
      }));

    const result = await completeAiText({ ...request, engine: "navy-qwen-3-6" }, { env, fetchImpl });

    expect(result).toMatchObject({
      text: "ГОТОВЫЙ НЕДЕЛЬНЫЙ ПЛАН",
      engine: "navy-deepseek-flash",
      fallbackUsed: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("falls through a Navy model-specific 400 before any text exists", async () => {
    const env = {
      NAVYAI_API_KEY: "secret",
      NAVYAI_API_URL: "https://navy.example/v1",
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("bad model parameters", { status: 400 }))
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: "FALLBACK POST" }, finish_reason: "stop" }],
      }));

    const result = await completeAiText({ ...request, engine: "navy-deepseek-pro" }, {
      env,
      fetchImpl,
    });

    expect(result).toMatchObject({
      text: "FALLBACK POST",
      engine: "navy-deepseek-flash",
      fallbackUsed: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not send a Navy 400 to an explicitly different provider", async () => {
    const env = {
      NAVYAI_API_KEY: "secret",
      OPENAI_API_KEY: "other-secret",
      AI_FALLBACK_ENGINES: "openai",
      AI_FALLBACK_STRICT: "1",
    };
    const fetchImpl = vi.fn(async () => new Response("bad parameters", { status: 400 }));

    await expect(completeAiText({ ...request, engine: "navy-deepseek-pro" }, { env, fetchImpl }))
      .rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("skips an explicit cross-provider fallback after a Navy model rejection and reaches the next Navy model", async () => {
    const env = {
      NAVYAI_API_KEY: "secret",
      OPENAI_API_KEY: "other-secret",
      AI_FALLBACK_ENGINES: "openai",
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("bad model parameters", { status: 400 }))
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: "NAVY FALLBACK" }, finish_reason: "stop" }],
      }));

    const result = await completeAiText({ ...request, engine: "navy-deepseek-pro" }, {
      env,
      fetchImpl,
    });

    expect(result).toMatchObject({
      text: "NAVY FALLBACK",
      engine: "navy-deepseek-flash",
      attempts: 2,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["openai", { OPENAI_API_KEY: "secret" }, { choices: [{ message: { content: "PARTIAL" }, finish_reason: null }] }],
    ["claude", { ANTHROPIC_API_KEY: "secret" }, { content: [{ type: "text", text: "PARTIAL" }], stop_reason: null }],
    ["local", {}, { message: { content: "PARTIAL" }, done: false }],
  ])("rejects a non-terminal %s completion", async (engine, env, body) => {
    const error = await completeAiText({ ...request, engine }, {
      env,
      fetchImpl: vi.fn(async () => Response.json(body)),
      circuitFailureThreshold: 20,
    }).catch((value) => value);
    expect(error).toBeInstanceOf(AiCompletionError);
    expect(error).toMatchObject({ code: "stream_truncated" });
  });

  it("preserves explicit length-limited text only when the content caller opts in", async () => {
    const body = { choices: [{ message: { content: "USEFUL PARTIAL" }, finish_reason: "length" }] };
    const fetchImpl = vi.fn(async () => Response.json(body));

    await expect(completeAiText({
      ...request,
      engine: "openai",
      acceptLengthLimitedOutput: true,
    }, {
      env: { OPENAI_API_KEY: "secret" },
      fetchImpl,
    })).resolves.toMatchObject({ text: "USEFUL PARTIAL", engine: "openai" });

    await expect(completeAiText({ ...request, engine: "openai" }, {
      env: { OPENAI_API_KEY: "secret" },
      fetchImpl,
    })).rejects.toMatchObject({ code: "stream_truncated" });
  });

  it("serializes concurrent completions sent to the same local Ollama model", async () => {
    let active = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return Response.json({ message: { content: "LOCAL" }, done: true, done_reason: "stop" });
    });

    await Promise.all([
      completeAiText({ ...request, engine: "local" }, { env: {}, fetchImpl }),
      completeAiText({ ...request, engine: "local" }, { env: {}, fetchImpl }),
      completeAiText({ ...request, engine: "local" }, { env: {}, fetchImpl }),
    ]);

    expect(peak).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("uses a separate longer timeout for a local fallback", async () => {
    const env = {
      NAVYAI_API_KEY: "secret",
      AI_FALLBACK_ENGINES: "local",
      AI_FALLBACK_STRICT: "1",
    };
    const fetchImpl = vi.fn(async () => {
      if (fetchImpl.mock.calls.length === 1) return new Response("unavailable", { status: 503 });
      await new Promise((resolve) => setTimeout(resolve, 150));
      return Response.json({ message: { content: "LOCAL" }, done: true, done_reason: "stop" });
    });

    const result = await completeAiText({ ...request, engine: "navy-deepseek-pro" }, {
      env,
      fetchImpl,
      timeoutMs: 100,
      localTimeoutMs: 500,
    });

    expect(result).toMatchObject({ text: "LOCAL", engine: "local", fallbackUsed: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("lets the overall deadline abort a request waiting in the local FIFO", async () => {
    const fetchImpl = vi.fn((_url, init) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json({
        message: { content: "LOCAL" },
        done: true,
        done_reason: "stop",
      })), 250);
      init.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal.reason);
      }, { once: true });
    }));
    const first = completeAiText({ ...request, engine: "local" }, {
      env: {},
      fetchImpl,
      overallTimeoutMs: 1_000,
      localTimeoutMs: 1_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const startedAt = Date.now();

    await expect(completeAiText({ ...request, engine: "local" }, {
      env: {},
      fetchImpl,
      overallTimeoutMs: 100,
      localTimeoutMs: 1_000,
    })).rejects.toMatchObject({ code: "overall_timeout", status: 504 });
    expect(Date.now() - startedAt).toBeLessThan(220);
    await first;
  });

  it("does not spend the attempt budget on open circuits", async () => {
    const env = {
      NAVYAI_API_KEY: "secret",
      AI_FALLBACK_ENGINES: "navy-gpt-5-4,navy-minimax-m3,navy-qwen-3-6",
      AI_FALLBACK_STRICT: "1",
    };
    const enginesToOpen = ["navy-deepseek-pro", "navy-gpt-5-4", "navy-minimax-m3"];
    for (const engine of enginesToOpen) {
      await expect(completeAiText({ ...request, engine }, {
        env,
        fetchImpl: vi.fn(async () => new Response("unavailable", { status: 503 })),
        allowFallback: false,
        circuitFailureThreshold: 1,
        circuitOpenMs: 100,
      })).rejects.toMatchObject({ status: 503 });
    }

    const fetchImpl = vi.fn(async () => Response.json({
      choices: [{ message: { content: "HEALTHY FOURTH" }, finish_reason: "stop" }],
    }));
    const result = await completeAiText({ ...request, engine: "navy-deepseek-pro" }, {
      env,
      fetchImpl,
      maxAttempts: 3,
      circuitOpenMs: 100,
    });

    expect(result).toMatchObject({ engine: "navy-qwen-3-6", attempts: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 110));
  });

  it("opens a circuit after the configured number of failures across requests", async () => {
    const env = {
      OPENAI_API_KEY: "secret",
      ANTHROPIC_API_KEY: "fallback-secret",
      AI_FALLBACK_ENGINES: "claude",
      AI_FALLBACK_STRICT: "1",
    };
    const failingPrimary = vi.fn(async (url) => {
      if (String(url).includes("api.openai.com")) {
        return new Response("unavailable", { status: 503 });
      }
      return Response.json({
        content: [{ type: "text", text: "CLAUDE FALLBACK" }],
        stop_reason: "end_turn",
      });
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(completeAiText({ ...request, engine: "openai" }, {
        env,
        fetchImpl: failingPrimary,
        circuitFailureThreshold: 2,
        circuitOpenMs: 100,
      })).resolves.toMatchObject({ engine: "claude" });
    }

    const telemetry = vi.fn();
    const recoveryFetch = vi.fn(async () => Response.json({
      content: [{ type: "text", text: "HEALTHY FALLBACK" }],
      stop_reason: "end_turn",
    }));
    await expect(completeAiText({ ...request, engine: "openai" }, {
      env,
      fetchImpl: recoveryFetch,
      telemetry,
      circuitFailureThreshold: 2,
      circuitOpenMs: 100,
    })).resolves.toMatchObject({ engine: "claude", attempts: 1 });
    expect(recoveryFetch).toHaveBeenCalledTimes(1);
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
      engine: "openai",
      outcome: "skipped",
      code: "circuit_open",
    }));
    await new Promise((resolve) => setTimeout(resolve, 110));
  });

  it("never silently substitutes an unsupported account engine", async () => {
    const fetchImpl = vi.fn();
    const error = await completeAiText({ ...request, engine: "yandex" }, {
      env: { NAVYAI_API_KEY: "secret" },
      fetchImpl,
    }).catch((value) => value);
    expect(error).toMatchObject({ code: "engine_unsupported", engine: "yandex" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
