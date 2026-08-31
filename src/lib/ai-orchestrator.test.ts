import { afterEach, describe, expect, it, vi } from "vitest";
import { AiProviderError, type GenerateParams } from "./ai-provider";
import {
  configuredFallbackEngines,
  orchestrateText,
  type AiOrchestrationEvent,
  type AiStreamFactory,
} from "./ai-orchestrator";
import { aiProviderCircuitBreaker, ProviderCircuitBreaker } from "./ai-provider-health";

const params: GenerateParams = { kind: "write", task: "Тест" };

async function collect(stream: AsyncGenerator<AiOrchestrationEvent>): Promise<AiOrchestrationEvent[]> {
  const result: AiOrchestrationEvent[] = [];
  for await (const event of stream) result.push(event);
  return result;
}

afterEach(() => {
  vi.useRealTimers();
  aiProviderCircuitBreaker.reset();
});

describe("AI provider orchestration", () => {
  it("переключается на fallback только после transient-сбоя до первого текста", async () => {
    const calls: string[] = [];
    const factory: AiStreamFactory = async function* (_input, engine) {
      calls.push(engine);
      if (engine === "navy-deepseek-pro") throw new AiProviderError(engine, 503, "http_error");
      yield "готово";
    };

    const events = await collect(orchestrateText(params, "navy-deepseek-pro", {
      fallbackEngines: ["navy-deepseek-flash"],
      streamFactory: factory,
    }));

    expect(calls).toEqual(["navy-deepseek-pro", "navy-deepseek-flash"]);
    expect(events).toContainEqual({
      type: "fallback",
      fromEngine: "navy-deepseek-pro",
      toEngine: "navy-deepseek-flash",
      reason: "provider_unavailable",
      attempt: 2,
    });
    expect(events.filter((event) => event.type === "delta")).toEqual([
      { type: "delta", engine: "navy-deepseek-flash", text: "готово" },
    ]);
  });

  it("tries another Navy model when one route rejects parameters before first text", async () => {
    const calls: string[] = [];
    const factory: AiStreamFactory = async function* (_input, engine) {
      calls.push(engine);
      if (engine === "navy-deepseek-pro") throw new AiProviderError(engine, 400, "bad_request");
      yield "готовый пост";
    };

    const events = await collect(orchestrateText(params, "navy-deepseek-pro", {
      fallbackEngines: ["navy-qwen-3-6"],
      streamFactory: factory,
      circuitBreaker: null,
    }));

    expect(calls).toEqual(["navy-deepseek-pro", "navy-qwen-3-6"]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "fallback",
      fromEngine: "navy-deepseek-pro",
      toEngine: "navy-qwen-3-6",
      reason: "provider_error",
    }));
    expect(events).toContainEqual({ type: "delta", engine: "navy-qwen-3-6", text: "готовый пост" });
  });

  it("does not send a Navy 400 request to a different provider", async () => {
    const calls: string[] = [];
    const factory: AiStreamFactory = async function* (_input, engine) {
      calls.push(engine);
      throw new AiProviderError(engine, 400, "bad_request");
    };
    const run = collect(orchestrateText(params, "navy-deepseek-pro", {
      fallbackEngines: ["openai"],
      streamFactory: factory,
      circuitBreaker: null,
    }));

    await expect(run).rejects.toMatchObject({ status: 400 });
    expect(calls).toEqual(["navy-deepseek-pro"]);
  });

  it("uses a stable model-scoped provider key for every fallback attempt", async () => {
    const keys: string[] = [];
    const factory: AiStreamFactory = async function* (input, engine) {
      keys.push(String(input.providerRequestKey));
      if (engine === "navy-deepseek-pro") throw new AiProviderError(engine, 503, "http_error");
      yield "готово";
    };

    const run = () => collect(orchestrateText(
      { ...params, providerRequestKey: "stable-provider-operation" },
      "navy-deepseek-pro",
      {
        fallbackEngines: ["navy-gpt-5-4"],
        streamFactory: factory,
        circuitBreaker: null,
      },
    ));

    await run();
    await run();

    expect(keys).toHaveLength(4);
    expect(keys.every((key) => /^[a-f0-9]{64}$/u.test(key))).toBe(true);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys.slice(0, 2)).toEqual(keys.slice(2));
  });

  it("checks the per-attempt budget before opening each provider stream", async () => {
    const calls: string[] = [];
    const factory: AiStreamFactory = async function* (_input, engine) {
      calls.push(engine);
      if (engine === "navy-deepseek-pro") throw new AiProviderError(engine, 503, "http_error");
      yield "не должно выполниться";
    };
    const beforeAttempt = vi.fn(async ({ attempt }: { attempt: number }) => {
      if (attempt === 2) throw new Error("budget_exhausted");
    });
    const stream = collect(orchestrateText(params, "navy-deepseek-pro", {
      fallbackEngines: ["navy-deepseek-flash"],
      streamFactory: factory,
      beforeAttempt,
      circuitBreaker: null,
    }));

    await expect(stream).rejects.toThrow("budget_exhausted");
    expect(beforeAttempt).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(["navy-deepseek-pro"]);
  });

  it("не склеивает второй движок после уже показанного delta", async () => {
    const calls: string[] = [];
    const factory: AiStreamFactory = async function* (_input, engine) {
      calls.push(engine);
      yield "часть";
      throw new AiProviderError(engine, 503, "stream_error");
    };

    const events: AiOrchestrationEvent[] = [];
    const run = (async () => {
      for await (const event of orchestrateText(params, "navy-deepseek-pro", {
        fallbackEngines: ["navy-deepseek-flash"],
        streamFactory: factory,
      })) events.push(event);
    })();

    await expect(run).rejects.toMatchObject({ code: "stream_error" });
    expect(calls).toEqual(["navy-deepseek-pro"]);
    expect(events.some((event) => event.type === "fallback")).toBe(false);
    expect(events.some((event) => event.type === "delta" && event.text === "часть")).toBe(true);
  });

  it("отличает deadline первого token от общего deadline", async () => {
    vi.useFakeTimers();
    const factory: AiStreamFactory = async function* (_input, _engine, signal) {
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const stream = orchestrateText(params, "local", {
      firstTokenMs: 25,
      overallMs: 250,
      streamFactory: factory,
    });

    await expect(stream.next()).resolves.toMatchObject({ value: { type: "telemetry", outcome: "started" } });
    const failed = stream.next();
    await vi.advanceTimersByTimeAsync(25);
    await expect(failed).resolves.toMatchObject({
      value: { type: "telemetry", outcome: "failed", code: "first_token_timeout" },
    });
    await expect(stream.next()).rejects.toMatchObject({ code: "first_token_timeout" });
  });

  it("обрывает весь поток по overall deadline даже после первого token", async () => {
    vi.useFakeTimers();
    const factory: AiStreamFactory = async function* (_input, _engine, signal) {
      yield "начало";
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const stream = orchestrateText(params, "local", {
      firstTokenMs: 50,
      overallMs: 100,
      streamFactory: factory,
    });

    await stream.next(); // started
    await stream.next(); // first_token
    await expect(stream.next()).resolves.toMatchObject({ value: { type: "delta", text: "начало" } });
    const failed = stream.next();
    await vi.advanceTimersByTimeAsync(100);
    await expect(failed).resolves.toMatchObject({
      value: { type: "telemetry", outcome: "failed", code: "overall_timeout" },
    });
    await expect(stream.next()).rejects.toMatchObject({ code: "overall_timeout" });
  });

  it("отмена клиента не запускает fallback", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const factory: AiStreamFactory = async function* (_input, engine, signal) {
      calls.push(engine);
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const stream = orchestrateText(params, "navy-deepseek-pro", {
      signal: controller.signal,
      fallbackEngines: ["navy-deepseek-flash"],
      streamFactory: factory,
    });

    await stream.next();
    const failed = stream.next();
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(failed).resolves.toMatchObject({ value: { type: "telemetry", outcome: "failed" } });
    await expect(stream.next()).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toEqual(["navy-deepseek-pro"]);
  });

  it("по умолчанию держит fallback внутри NavyAI и не отправляет local primary в облако", () => {
    const env = { NAVYAI_API_KEY: "test" };
    // Recovery is ordered by which routes answer, so the models observed failing upstream
    // are asked last instead of consuming the attempt budget first.
    expect(configuredFallbackEngines("navy-deepseek-pro", env)).toEqual([
      "navy-deepseek-flash",
      "navy-qwen-3-6",
      "navy-minimax-m3",
      "navy-gpt-5-4",
    ]);
    expect(configuredFallbackEngines("local", { ...env, AI_FALLBACK_ENGINES: "openai" })).toEqual([]);
  });

  it("honors the explicit healthy fallback order before the automatic safety fleet", () => {
    expect(configuredFallbackEngines("navy-gpt-5-4", {
      NAVYAI_API_KEY: "test",
      AI_FALLBACK_ENGINES: "navy-minimax-m3,local",
    })).toEqual([
      "navy-minimax-m3",
      "local",
      "navy-deepseek-flash",
      "navy-qwen-3-6",
      "navy-deepseek-pro",
    ]);
  });

  it("не вызывает primary с открытым circuit и честно отмечает skip перед fallback", async () => {
    const breaker = new ProviderCircuitBreaker({ failureThreshold: 1, openMs: 60_000 });
    breaker.recordFailure("navy-deepseek-pro", {
      code: "first_token_timeout",
      transient: true,
      latencyMs: 10_000,
    }, 100);
    const calls: string[] = [];
    const factory: AiStreamFactory = async function* (_input, engine) {
      calls.push(engine);
      yield "fallback ok";
    };

    const events = await collect(orchestrateText(params, "navy-deepseek-pro", {
      fallbackEngines: ["navy-deepseek-flash"],
      streamFactory: factory,
      circuitBreaker: breaker,
      now: () => 200,
    }));

    expect(calls).toEqual(["navy-deepseek-flash"]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "telemetry", engine: "navy-deepseek-pro", outcome: "skipped", code: "circuit_open" }),
      expect.objectContaining({ type: "fallback", reason: "circuit_open", toEngine: "navy-deepseek-flash" }),
      expect.objectContaining({ type: "delta", engine: "navy-deepseek-flash", text: "fallback ok" }),
    ]));
  });
});
