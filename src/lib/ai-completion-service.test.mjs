import { describe, expect, it, vi } from "vitest";

import { AiCompletionError, completeAiText } from "./ai-completion-service.mjs";
import { configuredAiConcurrency, configuredServiceEngine } from "./ai-engine-policy.mjs";

const request = { system: "SYSTEM", user: "USER", temperature: 0.2, maxTokens: 300 };

describe("shared direct/background AI completion service", () => {
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
    expect(configuredServiceEngine(null, env)).toBe("navy-deepseek-pro");
    const result = await completeAiText(request, { env, fetchImpl });

    expect(result).toMatchObject({ text: "DONE", engine: "navy-deepseek-pro", fallbackUsed: false });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://navy.example/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      model: "deepseek-v4-pro",
      max_tokens: 3_000,
      reasoning_effort: "none",
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

  it("reserves visible-output budget for every reasoning-capable Navy engine", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      choices: [{ message: { content: "DONE" }, finish_reason: "stop" }],
    }));
    await completeAiText({ ...request, engine: "navy-minimax-m3", maxTokens: 60 }, {
      env: { NAVYAI_API_KEY: "secret", NAVYAI_API_URL: "https://navy.example/v1" },
      fetchImpl,
      allowFallback: false,
    });

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      model: "minimax-m3",
      max_tokens: 3_000,
    });
  });

  it("can disable provider fallback for one evidence-sensitive request", async () => {
    const env = {
      NAVYAI_API_KEY: "secret",
      NAVYAI_API_URL: "https://navy.example/v1",
      AI_FALLBACK_ENGINES: "navy-deepseek-flash",
    };
    const fetchImpl = vi.fn(async () => new Response("unavailable", { status: 503 }));
    await expect(completeAiText(request, { env, fetchImpl, allowFallback: false }))
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

  it.each([
    ["openai", { OPENAI_API_KEY: "secret" }, { choices: [{ message: { content: "PARTIAL" }, finish_reason: null }] }],
    ["claude", { ANTHROPIC_API_KEY: "secret" }, { content: [{ type: "text", text: "PARTIAL" }], stop_reason: null }],
    ["local", {}, { message: { content: "PARTIAL" }, done: false }],
  ])("rejects a non-terminal %s completion", async (engine, env, body) => {
    const error = await completeAiText({ ...request, engine }, {
      env,
      fetchImpl: vi.fn(async () => Response.json(body)),
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
