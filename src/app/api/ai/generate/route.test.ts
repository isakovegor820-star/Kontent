import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  query: vi.fn(),
  channelAiContextFor: vi.fn(),
  styleSamplesFor: vi.fn(),
  lookupAiUsageRequest: vi.fn(),
  acquireAiUsageRequest: vi.fn(),
  stageAiUsageResult: vi.fn(),
  commitAiUsageResult: vi.fn(),
  releaseAiUsageRequest: vi.fn(),
  aiReady: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/ai-usage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-usage")>();
  return {
    ...actual,
    AI_DAILY_LIMIT: 30,
    channelAiContextFor: mocks.channelAiContextFor,
    styleSamplesFor: mocks.styleSamplesFor,
    lookupAiUsageRequest: mocks.lookupAiUsageRequest,
    acquireAiUsageRequest: mocks.acquireAiUsageRequest,
    stageAiUsageResult: mocks.stageAiUsageResult,
    commitAiUsageResult: mocks.commitAiUsageResult,
    releaseAiUsageRequest: mocks.releaseAiUsageRequest,
  };
});
vi.mock("@/lib/ai-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-provider")>();
  return { ...actual, aiReady: mocks.aiReady };
});

import { generationDeadlines } from "@/lib/ai-generation-deadlines";
import { POST } from "./route";

describe("generation deadlines", () => {
  it("does not false-fail balanced Navy startup at the old 12-second boundary", () => {
    expect(generationDeadlines("balanced", {})).toEqual({
      firstTokenMs: 30_000,
      attemptOverallMs: 75_000,
      pipelineOverallMs: 150_000,
    });
  });

  it("keeps an explicit operator timeout bounded", () => {
    expect(generationDeadlines("balanced", { AI_BALANCED_FIRST_TOKEN_MS: "45000" }).firstTokenMs)
      .toBe(45_000);
  });
});

function request(channelId = 42) {
  return new NextRequest("http://localhost/api/ai/generate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "route_test_1234",
    },
    body: JSON.stringify({ command: "write", input: "Короткий бриф", channelId }),
  });
}

function studioRequest() {
  return new NextRequest("http://localhost/api/ai/generate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "studio_stream_test_1",
    },
    body: JSON.stringify({
      command: "write",
      input: "Короткий бриф без обязательных фактов",
      surface: "studio",
      postSettings: {
        qualityMode: "fast",
        factStrictness: "general",
        hideCriticalResult: false,
        length: "custom",
        customMinChars: 50,
        customMaxChars: 2000,
      },
    }),
  });
}

function editorialRequest() {
  return new NextRequest("http://localhost/api/ai/generate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "editorial_stream_test_1",
    },
    body: JSON.stringify({
      command: "write",
      input: "Подготовь спокойный пост с одним понятным следующим шагом",
      surface: "studio",
      postSettings: {
        qualityMode: "balanced",
        factStrictness: "general",
        hideCriticalResult: false,
        autoImprove: false,
        length: "custom",
        customMinChars: 20,
        customMaxChars: 2000,
      },
    }),
  });
}

function reviewableBlockedEditorialRequest() {
  return new NextRequest("http://localhost/api/ai/generate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "editorial_reviewable_blocked_1",
    },
    body: JSON.stringify({
      command: "write",
      input: "Подготовь короткий спокойный черновик",
      surface: "composer",
      postSettings: {
        qualityMode: "balanced",
        factStrictness: "general",
        hideCriticalResult: true,
        autoImprove: false,
        length: "custom",
        customMinChars: 1000,
        customMaxChars: 2000,
      },
    }),
  });
}

function studioReferenceRequest() {
  return new NextRequest("http://localhost/api/ai/generate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "studio_reference_test_1",
    },
    body: JSON.stringify({
      command: "write",
      input: "Создай оригинальный пост по механике референса без новой конкретики",
      referenceText: "15 сентября откроется реестр из 136 источников.",
      referenceSource: "Конкурент",
      surface: "studio",
      postSettings: {
        qualityMode: "fast",
        factStrictness: "verified",
        hideCriticalResult: false,
        length: "custom",
        customMinChars: 20,
        customMaxChars: 2000,
      },
    }),
  });
}

function trendsRequest() {
  return new NextRequest("http://localhost/api/ai/generate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "trends_stream_test_1",
    },
    body: JSON.stringify({
      command: "write",
      input: "Тема поста из ленты конкурентов",
      surface: "trends",
      channelId: 42,
      context: "У конкурента вышел сильный пост. Напиши свой угол, не копию.",
      postSettings: {
        qualityMode: "balanced",
        factStrictness: "verified",
        hideCriticalResult: false,
      },
    }),
  });
}

describe("POST /api/ai/generate prerequisites", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.query.mockResolvedValue({
      rows: [{ ai_mood: null, ai_engine: "local", ai_post_settings: null }],
      rowCount: 1,
    });
    mocks.channelAiContextFor.mockResolvedValue(null);
    mocks.styleSamplesFor.mockResolvedValue([]);
    mocks.lookupAiUsageRequest.mockResolvedValue({ state: "missing", reservationId: null, result: null });
    mocks.acquireAiUsageRequest.mockResolvedValue({
      allowed: true,
      used: 1,
      limit: 30,
      reservationId: 81,
      reservationKey: "web:studio_stream_test_1",
      status: "reserved",
      expiresAt: "2026-08-02T12:00:00.000Z",
      requestState: "acquired",
      result: null,
    });
    mocks.stageAiUsageResult.mockImplementation(async (_userId, _reservationId, _operationId, result) => ({
      changed: true,
      status: "reserved",
      result,
    }));
    mocks.commitAiUsageResult.mockResolvedValue({ changed: true, status: "committed", result: null });
    mocks.releaseAiUsageRequest.mockResolvedValue(true);
    mocks.aiReady.mockResolvedValue(true);
    vi.unstubAllGlobals();
  });

  it("creates a correlation ID before rejecting a cross-site preflight", async () => {
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await POST(new NextRequest("https://aurora.test/api/ai/generate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ command: "write", input: "ignored" }),
    }));
    const body = await response.json();
    warnLog.mockRestore();

    expect(response.status).toBe(403);
    expect(body).toMatchObject({ error: "forbidden_origin", requestId: expect.any(String) });
    expect(body.requestId).toBe(response.headers.get("x-ai-request-id"));
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
  });

  it("reports session storage failure as a retryable 503", async () => {
    mocks.getSessionUser.mockRejectedValue(new Error("database offline"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(request());
    errorLog.mockRestore();

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    await expect(response.json()).resolves.toMatchObject({
      error: "session_unavailable",
      retryable: true,
      retryAfterSeconds: 30,
      requestId: expect.any(String),
    });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("does not turn an unavailable authoritative settings row into defaults", async () => {
    mocks.query.mockRejectedValue(new Error("database offline"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(request());
    errorLog.mockRestore();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "settings_unavailable",
      retryable: true,
    });
    expect(mocks.channelAiContextFor).not.toHaveBeenCalled();
  });

  it("distinguishes channel context storage failure from a missing channel", async () => {
    mocks.channelAiContextFor.mockRejectedValue(new Error("database offline"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(request());
    errorLog.mockRestore();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "context_unavailable",
      retryable: true,
    });
    expect(mocks.acquireAiUsageRequest).not.toHaveBeenCalled();
  });

  it("returns 422 only when the requested owned active channel genuinely does not exist", async () => {
    const response = await POST(request());

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: "channel_not_found", requestId: expect.any(String) });
    expect(mocks.channelAiContextFor).toHaveBeenCalledWith(7, 42, expect.any(Number));
    expect(mocks.acquireAiUsageRequest).not.toHaveBeenCalled();
  });

  it("releases quota and emits no terminal done when provider EOF lacks done:true", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      '{"message":{"content":"ОБОРВАННЫЙ ТЕКСТ"}}\n',
      { status: 200, headers: { "content-type": "application/x-ndjson" } },
    )));

    const response = await POST(studioRequest());
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));

    expect(events.some((event) => event.type === "error" && event.code === "stream_truncated")).toBe(true);
    expect(events.some((event) => event.type === "done")).toBe(false);
    expect(mocks.commitAiUsageResult).not.toHaveBeenCalled();
    expect(mocks.releaseAiUsageRequest).toHaveBeenCalledWith(7, 81, response.headers.get("x-ai-request-id"));
  });

  it("stages a complete reviewable result and sends combined validation before ACK-required done", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      '{"message":{"content":"Полный ответ с содержательным утверждением."},"done":true}\n',
      { status: 200, headers: { "content-type": "application/x-ndjson" } },
    )));

    const response = await POST(studioRequest());
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    const validationIndex = events.findIndex((event) => event.type === "validation");
    const doneIndex = events.findIndex((event) => event.type === "done");
    const requestId = response.headers.get("x-ai-request-id");

    expect(events[validationIndex]).toMatchObject({ status: "blocked", requiresReview: true });
    expect(events[validationIndex].blockerCodes).toEqual(
      expect.arrayContaining([expect.stringMatching(/^post:/u)]),
    );
    expect(requestId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(events.every((event) => event.requestId === requestId)).toBe(true);
    expect(validationIndex).toBeGreaterThan(-1);
    expect(doneIndex).toBeGreaterThan(validationIndex);
    expect(events[doneIndex]).toMatchObject({ ackRequired: true });
    expect(response.headers.get("x-ai-ack-required")).toBe("true");
    expect(mocks.stageAiUsageResult).toHaveBeenCalledWith(7, 81, requestId, expect.objectContaining({
      protocol: "ndjson",
      text: "Полный ответ с содержательным утверждением.",
    }));
    expect(mocks.commitAiUsageResult).not.toHaveBeenCalled();
    expect(mocks.releaseAiUsageRequest).not.toHaveBeenCalled();
  });

  it("emits exactly one error and no done when terminal staging fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      '{"message":{"content":"Полный ответ, который можно подтвердить терминальным событием."},"done":true}\n',
      { status: 200, headers: { "content-type": "application/x-ndjson" } },
    )));
    mocks.stageAiUsageResult.mockRejectedValue(new Error("storage offline"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(studioRequest());
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    errorLog.mockRestore();

    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      error: "usage_finalization_unavailable",
    }));
    expect(events.some((event) => event.type === "done")).toBe(false);
    expect(mocks.commitAiUsageResult).not.toHaveBeenCalled();
    expect(mocks.releaseAiUsageRequest).toHaveBeenCalledOnce();
  });

  it("releases quota when the consumer cancels before done", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(
            `${JSON.stringify({ message: { content: "Начало ответа" } })}\n`,
          ));
          init?.signal?.addEventListener("abort", () => {
            controller.error(init.signal?.reason ?? new DOMException("cancelled", "AbortError"));
          }, { once: true });
        },
      }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(studioRequest());
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let deltaReceived = false;
    while (!deltaReceived) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      const event = JSON.parse(decoder.decode(chunk.value));
      deltaReceived = event.type === "delta";
    }
    await reader.cancel(new DOMException("cancelled", "AbortError"));

    await vi.waitFor(() => expect(mocks.releaseAiUsageRequest).toHaveBeenCalledOnce());
    expect(mocks.commitAiUsageResult).not.toHaveBeenCalled();
  });

  it("treats an interrupted editorial pass as failed and reuses stable phase idempotency keys", async () => {
    const draft = "Перед публикацией выберите один тезис и покажите читателю следующий понятный шаг.";
    const edited = "Сначала назовите проблему читателя, затем предложите конкретное действие и завершите пост спокойным вопросом.";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(
        `${JSON.stringify({ message: { content: draft }, done: true })}\n`,
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(
        `${JSON.stringify({ message: { content: "Оборванный редакторский текст" } })}\n`,
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(
        `${JSON.stringify({ message: { content: draft }, done: true })}\n`,
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(
        `${JSON.stringify({ message: { content: edited }, done: true })}\n`,
        { status: 200 },
      ));
    vi.stubGlobal("fetch", fetchMock);

    const failedResponse = await POST(editorialRequest());
    const failedEvents = (await failedResponse.text()).trim().split("\n").map((line) => JSON.parse(line));

    expect(failedEvents).toContainEqual(expect.objectContaining({ type: "error", code: "stream_truncated" }));
    expect(failedEvents.some((event) => event.type === "done")).toBe(false);
    expect(failedEvents.some((event) => event.pipeline === "draft-fallback")).toBe(false);
    expect(mocks.commitAiUsageResult).not.toHaveBeenCalled();
    expect(mocks.releaseAiUsageRequest).toHaveBeenCalledOnce();

    mocks.releaseAiUsageRequest.mockClear();
    const retryResponse = await POST(editorialRequest());
    const retryEvents = (await retryResponse.text()).trim().split("\n").map((line) => JSON.parse(line));
    const providerHeaders = fetchMock.mock.calls.map((call) => new Headers((call[1] as RequestInit).headers));
    const keys = providerHeaders.map((headers) => headers.get("idempotency-key"));
    const requestIds = providerHeaders.map((headers) => headers.get("x-request-id"));

    expect(retryEvents).toContainEqual(expect.objectContaining({ type: "done", pipeline: "editorial" }));
    expect(mocks.stageAiUsageResult).toHaveBeenCalledOnce();
    expect(mocks.commitAiUsageResult).not.toHaveBeenCalled();
    expect(mocks.releaseAiUsageRequest).not.toHaveBeenCalled();
    expect(keys[0]).toMatch(/^[a-f0-9]{64}$/u);
    expect(keys[1]).toMatch(/^[a-f0-9]{64}$/u);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[2]).toBe(keys[0]);
    expect(keys[3]).toBe(keys[1]);
    expect(requestIds[0]).toBe(failedResponse.headers.get("x-ai-request-id"));
    expect(requestIds[1]).toBe(requestIds[0]);
    expect(requestIds[2]).toBe(retryResponse.headers.get("x-ai-request-id"));
    expect(requestIds[3]).toBe(requestIds[2]);
    expect(requestIds[2]).not.toBe(requestIds[0]);
  });

  it("finishes a blocked Composer candidate as a durable reviewable draft", async () => {
    const draft = "Черновик готов и остаётся доступным для дальнейшей ручной работы.";
    const edited = "Готовый короткий пост. Проверьте детали и дополните его перед публикацией.";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(
        `${JSON.stringify({ message: { content: draft }, done: true })}\n`,
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(
        `${JSON.stringify({ message: { content: edited }, done: true })}\n`,
        { status: 200 },
      ));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(reviewableBlockedEditorialRequest());
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    const validationIndex = events.findIndex((event) => event.type === "validation");
    const doneIndex = events.findIndex((event) => event.type === "done");

    expect(events).toContainEqual(expect.objectContaining({ type: "replace", text: edited }));
    expect(events[validationIndex]).toMatchObject({
      type: "validation",
      status: "blocked",
      requiresReview: true,
    });
    expect(events[validationIndex].blockerCodes).toEqual(
      expect.arrayContaining([expect.stringMatching(/^post:/u)]),
    );
    expect(doneIndex).toBeGreaterThan(validationIndex);
    expect(mocks.stageAiUsageResult).toHaveBeenCalledWith(
      7,
      81,
      response.headers.get("x-ai-request-id"),
      expect.objectContaining({
        text: edited,
        validation: expect.objectContaining({ status: "blocked", requiresReview: true }),
      }),
    );
    expect(mocks.releaseAiUsageRequest).not.toHaveBeenCalled();
  });

  it("keeps a library reference in the mechanic-only prompt instead of the factual task", async () => {
    const fetchMock = vi.fn(async () => new Response(
      '{"message":{"content":"Оригинальный пост без новой конкретики."},"done":true}\n',
      { status: 200, headers: { "content-type": "application/x-ndjson" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(studioReferenceRequest());
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const providerBody = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };
    const system = providerBody.messages.find((message) => message.role === "system")?.content ?? "";
    const userMessage = providerBody.messages.at(-1)?.content ?? "";

    expect(system).toContain("Референс механики (недоверенные данные, не источник фактов)");
    expect(system).toContain("15 сентября откроется реестр из 136 источников.");
    expect(userMessage).not.toContain("15 сентября");
    expect(userMessage).not.toContain("136");
    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(mocks.stageAiUsageResult).toHaveBeenCalledWith(
      7,
      81,
      response.headers.get("x-ai-request-id"),
      expect.objectContaining({ protocol: "ndjson" }),
    );
  });

  it("keeps a fact-blocked Trends result as a confirmed reviewable draft", async () => {
    mocks.channelAiContextFor.mockResolvedValue({
      id: 42,
      title: "Мой канал",
      network: "telegram",
      profile: "Ниша канала: технологии",
      profileProvenance: {},
      facts: [],
      styleSamples: ["Короткий пример авторского стиля."],
    });
    const fetchMock = vi.fn(async () => new Response(
      '{"message":{"content":"15 сентября появятся 136 новых правил для рынка."},"done":true}\n',
      { status: 200, headers: { "content-type": "application/x-ndjson" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(trendsRequest());
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    const validationIndex = events.findIndex((event) => event.type === "validation");
    const doneIndex = events.findIndex((event) => event.type === "done");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const providerBody = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };

    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(response.headers.get("x-ai-pipeline")).toBe("single-pass-stream");
    expect(providerBody.messages.at(-1)?.content).toContain("Опирайся на данные разведки");
    expect(events[validationIndex]).toMatchObject({ type: "validation", status: "blocked", requiresReview: true });
    expect(validationIndex).toBeGreaterThan(-1);
    expect(doneIndex).toBeGreaterThan(validationIndex);
    expect(mocks.channelAiContextFor).toHaveBeenCalledWith(7, 42, expect.any(Number));
    expect(mocks.stageAiUsageResult).toHaveBeenCalledWith(
      7,
      81,
      response.headers.get("x-ai-request-id"),
      expect.objectContaining({ protocol: "ndjson" }),
    );
    expect(mocks.releaseAiUsageRequest).not.toHaveBeenCalled();
  });

  it("returns a reserved Trends generation to the limit when the provider stream breaks", async () => {
    mocks.channelAiContextFor.mockResolvedValue({
      id: 42,
      title: "Мой канал",
      network: "telegram",
      profile: "Ниша канала: технологии",
      profileProvenance: {},
      facts: [],
      styleSamples: [],
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      '{"message":{"content":"Только начало поста"}}\n',
      { status: 200, headers: { "content-type": "application/x-ndjson" } },
    )));

    const response = await POST(trendsRequest());
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));

    expect(events.some((event) => event.type === "error" && event.code === "stream_truncated")).toBe(true);
    expect(events.some((event) => event.type === "done")).toBe(false);
    expect(mocks.commitAiUsageResult).not.toHaveBeenCalled();
    expect(mocks.releaseAiUsageRequest).toHaveBeenCalledWith(7, 81, response.headers.get("x-ai-request-id"));
  });

  it("replays a durable terminal result for the same key without provider or quota work", async () => {
    mocks.lookupAiUsageRequest.mockResolvedValue({
      state: "replay",
      reservationId: 81,
      result: {
        protocol: "ndjson",
        text: "Сохранённый результат",
        pipeline: "single",
        requestedEngine: "local",
        engine: "local",
        fallbackUsed: false,
        validation: {
          status: "not_checked",
          requiresReview: true,
          provenance: {},
          blockerCodes: [],
        },
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(studioRequest());
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));

    expect(response.headers.get("x-ai-replayed")).toBe("true");
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "replace", text: "Сохранённый результат" }),
      expect.objectContaining({ type: "done", replayed: true }),
    ]));
    expect(events.every((event) => event.requestId === response.headers.get("x-ai-request-id"))).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.acquireAiUsageRequest).not.toHaveBeenCalled();
    expect(mocks.commitAiUsageResult).not.toHaveBeenCalled();
  });

  it("replays a staged result awaiting ACK without another provider call", async () => {
    mocks.lookupAiUsageRequest.mockResolvedValue({
      state: "terminal_pending_ack",
      reservationId: 81,
      result: {
        protocol: "ndjson",
        text: "Подготовленный результат",
        pipeline: "single",
        requestedEngine: "local",
        engine: "local",
        fallbackUsed: false,
        validation: {
          status: "not_checked",
          requiresReview: true,
          provenance: {},
          blockerCodes: [],
        },
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(studioRequest());
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));

    expect(response.headers.get("x-ai-ack-required")).toBe("true");
    expect(events).toContainEqual(expect.objectContaining({
      type: "done",
      ackRequired: true,
      replayed: true,
    }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.acquireAiUsageRequest).not.toHaveBeenCalled();
    expect(mocks.stageAiUsageResult).not.toHaveBeenCalled();
  });

  it("rejects the same client key with a different request fingerprint before provider work", async () => {
    mocks.lookupAiUsageRequest.mockResolvedValue({ state: "conflict", reservationId: 81, result: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(studioRequest());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "idempotency_key_conflict",
      requestId: expect.any(String),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.acquireAiUsageRequest).not.toHaveBeenCalled();
    expect(mocks.stageAiUsageResult).not.toHaveBeenCalled();
  });

  it("keeps an unavailable selected model and proposes exactly one ready alternative before quota", async () => {
    mocks.query.mockResolvedValue({
      rows: [{ ai_mood: null, ai_engine: "openai", ai_post_settings: null }],
      rowCount: 1,
    });
    mocks.aiReady.mockResolvedValue(true);

    const response = await POST(studioRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      error: "engine_not_connected",
      engine: "openai",
      suggestedEngine: { id: "local" },
      requestId: expect.any(String),
    });
    expect(Array.isArray(body.suggestedEngine)).toBe(false);
    expect(mocks.acquireAiUsageRequest).not.toHaveBeenCalled();
  });

  it("maps provider authentication failures to a concrete terminal event", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      { error: { code: "invalid_api_key", message: "reflected provider text" } },
      { status: 401 },
    )));

    const response = await POST(studioRequest());
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      error: "provider_authentication_failed",
      status: 401,
      retryable: false,
      requestId: response.headers.get("x-ai-request-id"),
    }));
    expect(mocks.releaseAiUsageRequest).toHaveBeenCalledWith(7, 81, response.headers.get("x-ai-request-id"));
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("reflected provider text");
    errorLog.mockRestore();
  });

  it("does not switch providers after a runtime failure and suggests one ready model", async () => {
    vi.stubEnv("NAVYAI_API_KEY", "navy-test-key");
    vi.stubEnv("NAVYAI_API_URL", "https://navy-runtime-failure.example/v1");
    mocks.query.mockResolvedValue({
      rows: [{ ai_mood: null, ai_engine: "navy-deepseek-pro", ai_post_settings: null }],
      rowCount: 1,
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => Response.json(
      { error: { code: "provider_unavailable", message: "private provider detail" } },
      { status: 503 },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(studioRequest());
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(events.some((event) => event.type === "fallback")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      error: "provider_unavailable",
      retryable: true,
      suggestedEngine: { id: "navy-deepseek-flash", label: expect.any(String), vendor: expect.any(String) },
      requestId: response.headers.get("x-ai-request-id"),
    }));
    expect(mocks.commitAiUsageResult).not.toHaveBeenCalled();
    expect(mocks.releaseAiUsageRequest).toHaveBeenCalledOnce();
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("private provider detail");
    errorLog.mockRestore();
  });

  it("uses different provider idempotency keys after an explicitly confirmed engine change", async () => {
    vi.stubEnv("NAVYAI_API_KEY", "navy-test-key");
    vi.stubEnv("NAVYAI_API_URL", "https://navy-engine-change.example/v1");
    mocks.query
      .mockResolvedValueOnce({
        rows: [{ ai_mood: null, ai_engine: "navy-deepseek-pro", ai_post_settings: null }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ ai_mood: null, ai_engine: "navy-deepseek-flash", ai_post_settings: null }],
        rowCount: 1,
      });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      void url;
      void init;
      return Response.json(
        { error: { code: "provider_unavailable" } },
        { status: 503 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await (await POST(studioRequest())).text();
    await (await POST(studioRequest())).text();
    errorLog.mockRestore();

    const headers = fetchMock.mock.calls.map((call) => new Headers(call[1]?.headers));
    const keys = headers.map((item) => item.get("idempotency-key"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(keys[0]).toMatch(/^[a-f0-9]{64}:reasoning-minimal$/u);
    expect(keys[1]).toMatch(/^[a-f0-9]{64}:reasoning-minimal$/u);
    expect(keys[1]).not.toBe(keys[0]);
    expect(headers[1].get("x-request-id")).not.toBe(headers[0].get("x-request-id"));
    expect(mocks.stageAiUsageResult).not.toHaveBeenCalled();
    expect(mocks.commitAiUsageResult).not.toHaveBeenCalled();
  });
});
