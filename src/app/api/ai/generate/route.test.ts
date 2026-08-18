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
  getDraftForUser: vi.fn(),
  beginGenerationOperation: vi.fn(),
  failGenerationOperation: vi.fn(),
  lookupTerminalGenerationFailure: vi.fn(),
  stageGenerationArtifact: vi.fn(),
  recordAiProviderAttempt: vi.fn(),
  topicAlignment: vi.fn(),
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
vi.mock("@/lib/server-drafts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server-drafts")>();
  return { ...actual, getDraftForUser: mocks.getDraftForUser };
});
vi.mock("@/lib/generation-artifacts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/generation-artifacts")>();
  return {
    ...actual,
    beginGenerationOperation: mocks.beginGenerationOperation,
    failGenerationOperation: mocks.failGenerationOperation,
    lookupTerminalGenerationFailure: mocks.lookupTerminalGenerationFailure,
    stageGenerationArtifact: mocks.stageGenerationArtifact,
  };
});
vi.mock("@/lib/ai-attempt-budget", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-attempt-budget")>();
  return { ...actual, recordAiProviderAttempt: mocks.recordAiProviderAttempt };
});
vi.mock("@/lib/ai-semantic-adapter.mjs", () => ({
  createConfiguredSemanticAdapter: () => ({
    id: "route-test-topic-semantic-v1",
    checkTopicAlignment: mocks.topicAlignment,
  }),
}));

import { generationDeadlines } from "@/lib/ai-generation-deadlines";
import { presetQuality } from "@/lib/post-quality.mjs";
import { POST } from "./route";

describe("generation deadlines", () => {
  it("does not false-fail balanced Navy startup at the old 12-second boundary", () => {
    expect(generationDeadlines("balanced", {})).toEqual({
      firstTokenMs: 60_000,
      attemptOverallMs: 120_000,
      pipelineOverallMs: 300_000,
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
      origin: "http://localhost",
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
      origin: "http://localhost",
      "content-type": "application/json",
      "idempotency-key": "studio_stream_test_1",
    },
    body: JSON.stringify({
      command: "write",
      input: "Короткий бриф без обязательных фактов",
      channelId: 42,
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

function studioFactCheckOffRequest() {
  return new NextRequest("http://localhost/api/ai/generate", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      "content-type": "application/json",
      "idempotency-key": "studio_fact_check_off_1",
    },
    body: JSON.stringify({
      command: "write",
      input: "Конференция по банкротству состоится 26 сентября",
      channelId: 42,
      surface: "studio",
      postSettings: {
        qualityMode: "fast",
        factStrictness: "off",
        hideCriticalResult: false,
        length: "custom",
        customMinChars: 50,
        customMaxChars: 2000,
      },
    }),
  });
}

function studioSparseLegalBriefRequest() {
  return new NextRequest("http://localhost/api/ai/generate", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      "content-type": "application/json",
      "idempotency-key": "studio_sparse_legal_brief_1",
    },
    body: JSON.stringify({
      command: "write",
      input: "Напиши пост о конференции по банкротству 26 сентября",
      channelId: 42,
      surface: "studio",
      postSettings: {
        qualityMode: "fast",
        factStrictness: "verified",
        hideCriticalResult: true,
        length: "custom",
        customMinChars: 1000,
        customMaxChars: 1600,
      },
    }),
  });
}

function editorialRequest() {
  return new NextRequest("http://localhost/api/ai/generate", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      "content-type": "application/json",
      "idempotency-key": "editorial_stream_test_1",
    },
    body: JSON.stringify({
      command: "write",
      input: "Подготовь спокойный пост с одним понятным следующим шагом",
      channelId: 42,
      surface: "studio",
      postSettings: {
        qualityMode: "maximum",
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

function balancedStudioRequest() {
  return new NextRequest("http://localhost/api/ai/generate", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      "content-type": "application/json",
      "idempotency-key": "balanced_single_pass_test_1",
    },
    body: JSON.stringify({
      command: "write",
      input: "Подготовь качественный пост одним сильным проходом",
      channelId: 42,
      surface: "studio",
      postSettings: {
        qualityMode: "balanced",
        factStrictness: "general",
        hideCriticalResult: false,
        length: "custom",
        customMinChars: 20,
        customMaxChars: 2000,
      },
    }),
  });
}

function maximumStudioRequest() {
  return new NextRequest("http://localhost/api/ai/generate", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      "content-type": "application/json",
      "idempotency-key": "maximum_studio_ready_post_1",
    },
    body: JSON.stringify({
      command: "write",
      input: "Напиши короткий пост о конференции завтра",
      channelId: 42,
      surface: "studio",
      postSettings: {
        qualityMode: "maximum",
        qualityThreshold: 9,
        autoImprove: true,
        factStrictness: "general",
        hideCriticalResult: true,
        length: "custom",
        customMinChars: 1000,
        customMaxChars: 2000,
      },
    }),
  });
}

function reviewableBlockedEditorialRequest() {
  return new NextRequest("http://localhost/api/ai/generate", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      "content-type": "application/json",
      "idempotency-key": "editorial_reviewable_blocked_1",
    },
    body: JSON.stringify({
      command: "write",
      input: "Подготовь короткий спокойный черновик",
      channelId: 42,
      surface: "composer",
      postSettings: {
        qualityMode: "maximum",
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

function studioReferenceRequest(version = 3) {
  return new NextRequest("http://localhost/api/ai/generate", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      "content-type": "application/json",
      "idempotency-key": "studio_reference_test_1",
    },
    body: JSON.stringify({
      command: "write",
      input: "Клиентский текст не должен заменять серверную тему",
      channelId: 42,
      referenceDraftId: 71,
      referenceDraftVersion: version,
      referenceIntent: "create",
      referenceText: "ПОДМЕНЁННАЯ ТЕМА О КОФЕ",
      referenceSource: "Подмена",
      history: [
        { role: "user", content: "Раньше мы обсуждали кофе" },
        { role: "assistant", content: "Пост о кофейных зёрнах" },
      ],
      surface: "studio",
      postSettings: {
        qualityMode: "fast",
        factStrictness: "verified",
        hideCriticalResult: false,
        mainIdea: "Продажа билетов на конференцию",
        formality: "formal",
        cta: "none",
        length: "custom",
        customMinChars: 20,
        customMaxChars: 2000,
      },
    }),
  });
}

function ownedReferenceDraft(overrides: Record<string, unknown> = {}) {
  return {
    id: 71,
    text: "15 сентября Иван Петров описал 136 правил работы с реестром источников.",
    media: null,
    scheduled_at: null,
    origin: "competitor",
    purpose: "source_context",
    source_ref: {
      kind: "reference",
      id: "91",
      label: "Открытый источник",
      topic: "Правила работы с реестром источников",
    },
    client_key: "draft_reference_route_test_71",
    version: 3,
    review_policy_version: 1,
    ai_validation: null,
    generation_result_id: null,
    generation_binding_valid: false,
    human_review: null,
    created_at: "2026-08-05T10:00:00.000Z",
    updated_at: "2026-08-05T10:00:00.000Z",
    destinations: [{
      channel_id: 42,
      network: "tg",
      title: "Технологии Права",
      handle: "legal",
      is_active: true,
    }],
    ...overrides,
  };
}

function trendsRequest() {
  return new NextRequest("http://localhost/api/ai/generate", {
    method: "POST",
    headers: {
      origin: "http://localhost",
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
        length: "custom",
        customMinChars: 20,
        customMaxChars: 2000,
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
    mocks.channelAiContextFor.mockResolvedValue({
      id: 42,
      title: "Тестовый канал",
      network: "tg",
      profile: null,
      quality: null,
      postIndex: 1,
      facts: [],
      styleSamples: [],
    });
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
    mocks.getDraftForUser.mockResolvedValue(null);
    mocks.lookupTerminalGenerationFailure.mockResolvedValue(null);
    mocks.beginGenerationOperation.mockResolvedValue({ id: 301, state: "created" });
    mocks.failGenerationOperation.mockResolvedValue(true);
    mocks.recordAiProviderAttempt.mockResolvedValue({ estimatedCostMicrousd: 0 });
    mocks.topicAlignment.mockImplementation(async ({ text }: { text: string }) => (
      /(?:конференц|билет|места в зале)/iu.test(text)
        ? { verdict: "misaligned", confidence: 0.99, reasonCode: "unrelated_event" }
        : { verdict: "aligned", confidence: 0.96, reasonCode: "subject_developed" }
    ));
    mocks.stageGenerationArtifact.mockImplementation(async ({ text, validation }) => ({
      id: 501,
      text,
      resultHash: "a".repeat(64),
      validation,
    }));
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
    mocks.channelAiContextFor.mockResolvedValue(null);
    const response = await POST(request());

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: "channel_not_found", requestId: expect.any(String) });
    expect(mocks.channelAiContextFor).toHaveBeenCalledWith(7, 42, expect.any(Number));
    expect(mocks.acquireAiUsageRequest).not.toHaveBeenCalled();
  });

  it("lets Studio generate from a sparse legal brief and reports fact risk after the text", async () => {
    const fetchMock = vi.fn(async () => new Response(
      '{"message":{"content":"26 сентября состоится конференция по банкротству. Проверьте дату и программу перед публикацией."},"done":true}\n',
      { status: 200, headers: { "content-type": "application/x-ndjson" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(studioSparseLegalBriefRequest());
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({
      type: "replace",
      text: expect.stringContaining("26 сентября"),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "validation",
      status: "blocked",
      requiresReview: true,
    }));
    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("preserves provider text as a review-only Studio draft when EOF lacks done:true", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      '{"message":{"content":"ОБОРВАННЫЙ ТЕКСТ"}}\n',
      { status: 200, headers: { "content-type": "application/x-ndjson" } },
    )));

    const response = await POST(studioRequest());
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));

    expect(events).toContainEqual(expect.objectContaining({
      type: "validation",
      status: "blocked",
      requiresReview: true,
      blockerCodes: expect.arrayContaining(["provider:stream_truncated"]),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "replace",
      text: "оборванный текст",
    }));
    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(mocks.stageGenerationArtifact).toHaveBeenCalledOnce();
    expect(mocks.stageAiUsageResult).toHaveBeenCalledOnce();
    expect(mocks.commitAiUsageResult).not.toHaveBeenCalled();
    expect(mocks.releaseAiUsageRequest).not.toHaveBeenCalled();
  });

  it("stages a complete reviewable result and sends combined validation before ACK-required done", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      '{"message":{"content":"Полный содержательный ответ объясняет идею спокойно, точно и без лишних обещаний."},"done":true}\n',
      { status: 200, headers: { "content-type": "application/x-ndjson" } },
    )));

    const response = await POST(studioRequest());
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    const validationIndex = events.findIndex((event) => event.type === "validation");
    const doneIndex = events.findIndex((event) => event.type === "done");
    const requestId = response.headers.get("x-ai-request-id");

    expect(events[validationIndex]).toMatchObject({ status: "not_checked", requiresReview: true });
    expect(events[validationIndex].blockerCodes).toEqual([]);
    expect(requestId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(events.every((event) => event.requestId === requestId)).toBe(true);
    expect(validationIndex).toBeGreaterThan(-1);
    expect(doneIndex).toBeGreaterThan(validationIndex);
    expect(events[doneIndex]).toMatchObject({ ackRequired: true });
    expect(events).toContainEqual(expect.objectContaining({
      type: "delta",
      text: "Полный содержательный ответ объясняет идею спокойно, точно и без лишних обещаний.",
    }));
    expect(events.filter((event) => event.type === "replace")).toEqual([
      expect.objectContaining({
        text: "Полный содержательный ответ объясняет идею спокойно, точно и без лишних обещаний.",
      }),
    ]);
    expect(response.headers.get("x-ai-ack-required")).toBe("true");
    expect(mocks.stageAiUsageResult).toHaveBeenCalledWith(7, 81, requestId, expect.objectContaining({
      protocol: "ndjson",
      text: "Полный содержательный ответ объясняет идею спокойно, точно и без лишних обещаний.",
    }));
    expect(mocks.commitAiUsageResult).not.toHaveBeenCalled();
    expect(mocks.releaseAiUsageRequest).not.toHaveBeenCalled();
  });

  it("keeps balanced Studio generation to one streamed provider pass", async () => {
    const fetchMock = vi.fn(async () => new Response(
      '{"message":{"content":"Качественный пост готов за один проход."},"done":true}\n',
      { status: 200, headers: { "content-type": "application/x-ndjson" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(balancedStudioRequest());
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(response.headers.get("x-ai-pipeline")).toBe("single-pass-stream");
    expect(events).toContainEqual(expect.objectContaining({
      type: "delta",
      text: "Качественный пост готов за один проход.",
    }));
    expect(events).toContainEqual(expect.objectContaining({ type: "done", pipeline: "single" }));
  });

  it("does not block a dated post when factual validation is explicitly disabled", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      '{"message":{"content":"Конференция по банкротству состоится 26 сентября. Подробности встречи появятся в канале."},"done":true}\n',
      { status: 200, headers: { "content-type": "application/x-ndjson" } },
    )));

    const response = await POST(studioFactCheckOffRequest());
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));

    expect(events).toContainEqual(expect.objectContaining({
      type: "validation",
      status: "not_checked",
      requiresReview: true,
      blockerCodes: [],
    }));
    expect(events).toContainEqual(expect.objectContaining({ type: "done", ackRequired: true }));
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(mocks.stageAiUsageResult).toHaveBeenCalledWith(
      7,
      81,
      response.headers.get("x-ai-request-id"),
      expect.objectContaining({
        validation: expect.objectContaining({ status: "not_checked", requiresReview: true }),
      }),
    );
    expect(mocks.releaseAiUsageRequest).not.toHaveBeenCalled();
  });

  it("loads the channel standard into Studio and reports its deterministic blockers", async () => {
    mocks.channelAiContextFor.mockResolvedValue({
      id: 42,
      title: "Банкротство без паники",
      network: "tg",
      profile: "Аудитория канала: предприниматели",
      profileProvenance: {},
      quality: {
        ...presetQuality("expert"),
        preset: "custom",
        minChars: 500,
        maxChars: 800,
        tone: "Тёплый профессиональный тон",
      },
      facts: [],
      styleSamples: ["Ручной пример голоса автора."],
    });
    const fetchMock = vi.fn(async () => new Response(
      '{"message":{"content":"Короткий ответ."},"done":true}\n',
      { status: 200, headers: { "content-type": "application/x-ndjson" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(studioRequest());
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const providerBody = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };
    const system = providerBody.messages.find((message) => message.role === "system")?.content ?? "";
    const validation = events.find((event) => event.type === "validation");

    expect(system).toContain("РЕДАКЦИОННЫЙ СТАНДАРТ КАНАЛА");
    expect(system).toContain("Тёплый профессиональный тон");
    expect(system).toContain("500–800 знаков");
    expect(system).toContain("Ручной пример голоса автора.");
    expect(validation.blockerCodes).toEqual(expect.arrayContaining(["channel:too_short"]));
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
    const chunk = await reader.read();
    expect(chunk.done).toBe(false);
    expect(JSON.parse(decoder.decode(chunk.value))).toMatchObject({ type: "phase" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await reader.cancel(new DOMException("cancelled", "AbortError"));

    await vi.waitFor(() => expect(mocks.releaseAiUsageRequest).toHaveBeenCalledOnce());
    expect(mocks.commitAiUsageResult).not.toHaveBeenCalled();
  });

  it("returns the ready draft when an optional editorial pass is interrupted", async () => {
    const draft = "Перед публикацией выберите один тезис и покажите читателю следующий понятный шаг.";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(
        `${JSON.stringify({ message: { content: draft }, done: true })}\n`,
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(
        `${JSON.stringify({ message: { content: "Оборванный редакторский текст" } })}\n`,
        { status: 200 },
      ));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(editorialRequest());
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    const providerHeaders = fetchMock.mock.calls.map((call) => new Headers((call[1] as RequestInit).headers));
    const keys = providerHeaders.map((headers) => headers.get("idempotency-key"));
    const requestIds = providerHeaders.map((headers) => headers.get("x-request-id"));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: "done", pipeline: "draft-fallback" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "replace", pipeline: "draft-fallback", text: draft }));
    expect(mocks.stageAiUsageResult).toHaveBeenCalledOnce();
    expect(mocks.commitAiUsageResult).not.toHaveBeenCalled();
    expect(mocks.releaseAiUsageRequest).not.toHaveBeenCalled();
    expect(keys[0]).toMatch(/^[a-f0-9]{64}$/u);
    expect(keys[1]).toMatch(/^[a-f0-9]{64}$/u);
    expect(keys[0]).not.toBe(keys[1]);
    expect(requestIds[0]).toBe(response.headers.get("x-ai-request-id"));
    expect(requestIds[1]).toBe(requestIds[0]);
  });

  it("finishes a maximum-quality Studio post after one optional edit even when validation stays blocked", async () => {
    const draft = "Завтра встречаемся на конференции. Подробности и программа уже опубликованы.";
    const edited = "Конференция уже завтра. Выберите участие и присоединяйтесь к разговору о технологиях в праве.";
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

    const response = await POST(maximumStudioRequest());
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(expect.objectContaining({
      type: "validation",
      status: "blocked",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "replace",
      text: edited,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "done",
      ackRequired: true,
    }));
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(mocks.stageAiUsageResult).toHaveBeenCalledOnce();
    expect(mocks.releaseAiUsageRequest).not.toHaveBeenCalled();
  });

  it("returns a ready Composer post without repeated internal repairs", async () => {
    const draft = "Черновик готов и остаётся доступным для дальнейшей ручной работы.";
    const edited = "Готовый короткий пост. Проверьте детали и дополните его перед публикацией.";
    const fetchMock = vi.fn(async () => new Response(
      `${JSON.stringify({ message: { content: fetchMock.mock.calls.length === 1 ? draft : edited }, done: true })}\n`,
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(reviewableBlockedEditorialRequest());
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    const validationIndex = events.findIndex((event) => event.type === "validation");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events[validationIndex]).toMatchObject({
      type: "validation",
      status: "blocked",
      requiresReview: true,
    });
    expect(events[validationIndex].blockerCodes).toEqual(
      expect.arrayContaining([expect.stringMatching(/^post:/u)]),
    );
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: "replace",
      text: edited,
    }));
    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(mocks.stageAiUsageResult).toHaveBeenCalledOnce();
    expect(mocks.releaseAiUsageRequest).not.toHaveBeenCalled();
  });

  it("uses the owned reference semantic intent, isolates history and ignores client source substitution", async () => {
    mocks.getDraftForUser.mockResolvedValue(ownedReferenceDraft());
    mocks.channelAiContextFor.mockResolvedValue({
      id: 42,
      title: "Технологии Права",
      network: "tg",
      profile: "Профиль юридического канала",
      profileProvenance: {},
      facts: [],
      styleSamples: ["Пример спокойного авторского текста."],
    });
    const fetchMock = vi.fn(async () => new Response(
      '{"message":{"content":"Реестр источников полезно проверять по понятным правилам работы, не полагаясь на случайные сведения."},"done":true}\n',
      { status: 200, headers: { "content-type": "application/x-ndjson" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(studioReferenceRequest());
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const providerBody = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };
    const system = providerBody.messages.find((message) => message.role === "system")?.content ?? "";
    const userMessage = providerBody.messages.at(-1)?.content ?? "";

    expect(system).toContain("Обязательный semantic intent выбранного материала");
    expect(system).toContain("Правила работы с реестром источников");
    expect(system).toContain("15 сентября Иван Петров описал 136 правил");
    expect(system).not.toContain("ПОДМЕНЁННАЯ ТЕМА О КОФЕ");
    expect(system).not.toContain("Продажа билетов на конференцию");
    expect(userMessage).toContain("Правила работы с реестром источников");
    expect(userMessage).not.toContain("15 сентября");
    expect(userMessage).not.toContain("Иван Петров");
    expect(userMessage).not.toContain("136");
    expect(providerBody.messages.some((message) => message.content.includes("кофейных зёрнах"))).toBe(false);
    expect(system).toContain("20–2000 знаков");
    expect(system).toContain("формальность: формально");
    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      type: "validation",
      topicAlignment: expect.objectContaining({ status: "passed" }),
    }));
    expect(mocks.getDraftForUser).toHaveBeenCalledWith(7, 71);
    expect(mocks.stageAiUsageResult).toHaveBeenCalledWith(
      7,
      81,
      response.headers.get("x-ai-request-id"),
      expect.objectContaining({ protocol: "ndjson" }),
    );
  });

  it("returns an off-topic Studio result instead of hiding the generated post", async () => {
    mocks.getDraftForUser.mockResolvedValue(ownedReferenceDraft());
    mocks.channelAiContextFor.mockResolvedValue({
      id: 42,
      title: "Технологии Права",
      network: "tg",
      profile: "Юридический канал",
      profileProvenance: {},
      facts: [],
      styleSamples: [],
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(
        '{"message":{"content":"Регистрация на конференцию открыта, места в зале заканчиваются."},"done":true}\n',
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(
        '{"message":{"content":"Правила работы с реестром источников помогают не потерять предмет проверки и не подменять его случайными данными."},"done":true}\n',
        { status: 200 },
      ));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(studioReferenceRequest());
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "validation",
      topicAlignment: expect.objectContaining({ status: "failed" }),
    }));
    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      type: "replace",
      text: "Регистрация на конференцию открыта, места в зале заканчиваются.",
    }));
  });

  it("stages a terminal Studio post even when internal topic validation is blocked", async () => {
    mocks.getDraftForUser.mockResolvedValue(ownedReferenceDraft());
    mocks.channelAiContextFor.mockResolvedValue({
      id: 42,
      title: "Технологии Права",
      network: "tg",
      profile: "Юридический канал",
      profileProvenance: {},
      facts: [],
      styleSamples: [],
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      '{"message":{"content":"Покупайте билеты на конференцию и занимайте место в зале."},"done":true}\n',
      { status: 200 },
    )));
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await POST(studioReferenceRequest());
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    warnLog.mockRestore();

    expect(events).toContainEqual(expect.objectContaining({
      type: "validation",
      status: "blocked",
      requiresReview: true,
      blockerCodes: expect.arrayContaining(["topic:off_topic"]),
      topicAlignment: expect.objectContaining({ status: "failed" }),
    }));
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(mocks.stageGenerationArtifact).toHaveBeenCalledOnce();
    expect(mocks.stageAiUsageResult).toHaveBeenCalledOnce();
    expect(mocks.failGenerationOperation).not.toHaveBeenCalled();
    expect(mocks.releaseAiUsageRequest).not.toHaveBeenCalled();
  });

  it("rejects a missing or foreign reference draft before lookup, quota and provider work", async () => {
    mocks.getDraftForUser.mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(studioReferenceRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "reference_draft_forbidden" });
    expect(mocks.lookupAiUsageRequest).not.toHaveBeenCalled();
    expect(mocks.acquireAiUsageRequest).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("replays the same owned draft/version/request key without a second provider call", async () => {
    mocks.getDraftForUser.mockResolvedValue(ownedReferenceDraft());
    mocks.lookupAiUsageRequest.mockResolvedValue({
      state: "replay",
      reservationId: 81,
      result: {
        protocol: "ndjson",
        text: "Правила работы с реестром источников сохранены.",
        pipeline: "single",
        requestedEngine: "local",
        engine: "local",
        fallbackUsed: false,
        validation: {
          status: "not_checked",
          requiresReview: true,
          provenance: {},
          blockerCodes: [],
          topicAlignment: { status: "passed", score: 1, topic: "Правила работы с реестром источников" },
        },
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(studioReferenceRequest());
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));

    expect(events).toContainEqual(expect.objectContaining({ type: "done", replayed: true }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "validation",
      topicAlignment: expect.objectContaining({ status: "passed" }),
    }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.acquireAiUsageRequest).not.toHaveBeenCalled();
  });

  it("uses a new request fingerprint when the authoritative draft version changes", async () => {
    mocks.getDraftForUser
      .mockResolvedValueOnce(ownedReferenceDraft({ version: 3 }))
      .mockResolvedValueOnce(ownedReferenceDraft({ version: 4 }));
    mocks.lookupAiUsageRequest.mockResolvedValue({
      state: "in_progress",
      reservationId: 81,
      result: null,
    });

    expect((await POST(studioReferenceRequest(3))).status).toBe(409);
    expect((await POST(studioReferenceRequest(4))).status).toBe(409);

    const fingerprints = mocks.lookupAiUsageRequest.mock.calls.map((call) => call[2]);
    expect(fingerprints).toHaveLength(2);
    expect(fingerprints[0]).toMatch(/^[a-f0-9]{64}$/u);
    expect(fingerprints[1]).not.toBe(fingerprints[0]);
  });

  it("preserves a fact-blocked Trends result as a reviewable terminal draft", async () => {
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
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const providerBody = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };

    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(response.headers.get("x-ai-pipeline")).toBe("single-pass-stream");
    expect(providerBody.messages.at(-1)?.content).toContain("Опирайся на данные разведки");
    expect(events[validationIndex]).toMatchObject({ type: "validation", status: "blocked", requiresReview: true });
    expect(validationIndex).toBeGreaterThan(-1);
    expect(events.findIndex((event) => event.type === "done")).toBeGreaterThan(validationIndex);
    expect(mocks.channelAiContextFor).toHaveBeenCalledWith(7, 42, expect.any(Number));
    expect(events).toContainEqual(expect.objectContaining({
      type: "done",
      ackRequired: true,
      generationResultId: 501,
    }));
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(mocks.stageGenerationArtifact).toHaveBeenCalledOnce();
    expect(mocks.stageAiUsageResult).toHaveBeenCalledOnce();
    expect(mocks.failGenerationOperation).not.toHaveBeenCalled();
    expect(mocks.releaseAiUsageRequest).not.toHaveBeenCalled();
  });

  it("preserves a partial Trends generation instead of discarding it", async () => {
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

    expect(events).toContainEqual(expect.objectContaining({
      type: "replace",
      text: "Только начало поста",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "validation",
      status: "blocked",
      blockerCodes: expect.arrayContaining(["provider:stream_truncated"]),
    }));
    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(mocks.commitAiUsageResult).not.toHaveBeenCalled();
    expect(mocks.stageAiUsageResult).toHaveBeenCalledOnce();
    expect(mocks.releaseAiUsageRequest).not.toHaveBeenCalled();
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
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("AI_API_KEY", "");
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

  it("finishes through a same-provider fallback when the selected NavyAI model fails", async () => {
    vi.stubEnv("NAVYAI_API_KEY", "navy-test-key");
    vi.stubEnv("NAVYAI_API_URL", "https://navy-runtime-failure.example/v1");
    mocks.query.mockResolvedValue({
      rows: [{ ai_mood: null, ai_engine: "navy-deepseek-flash", ai_post_settings: null }],
      rowCount: 1,
    });
    mocks.aiReady.mockImplementation(async (engine) => (
      engine === "navy-deepseek-flash" || engine === "navy-gpt-5-4"
    ));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(
        { error: { code: "provider_timeout", message: "private provider detail" } },
        { status: 503 },
      ))
      .mockResolvedValueOnce(new Response(
        'data: {"choices":[{"delta":{"content":"Готовый резервный текст без выдуманных фактов."}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(studioRequest());
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(expect.objectContaining({
      type: "fallback",
      fromEngine: "navy-deepseek-flash",
      toEngine: "navy-gpt-5-4",
      reason: "overall_timeout",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "done",
      engine: "navy-gpt-5-4",
      requestedEngine: "navy-deepseek-flash",
      fallbackUsed: true,
    }));
    const providerBodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(providerBodies.map((body) => body.model)).toEqual(["deepseek-v4-flash", "gpt-5.4"]);
    expect(mocks.commitAiUsageResult).not.toHaveBeenCalled();
    expect(mocks.releaseAiUsageRequest).not.toHaveBeenCalled();
    expect(mocks.stageAiUsageResult).toHaveBeenCalled();
  });

  it("never sends or saves Qwen think output and falls back to a finished post", async () => {
    vi.stubEnv("NAVYAI_API_KEY", "navy-test-key");
    vi.stubEnv("NAVYAI_API_URL", "https://navy-think-leak.example/v1");
    mocks.query.mockResolvedValue({
      rows: [{ ai_mood: null, ai_engine: "navy-qwen-3-6", ai_post_settings: null }],
      rowCount: 1,
    });
    mocks.aiReady.mockImplementation(async (engine) => (
      engine === "navy-qwen-3-6" || engine === "navy-deepseek-flash"
    ));
    const post = "Приказ Рослесхоза изменяет форму проверочного листа. Перед применением важно сверить актуальную редакцию и подтверждённые требования.";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        'data: {"choices":[{"delta":{"content":"<th"}}]}\n\n'
        + 'data: {"choices":[{"delta":{"content":"ink>Here is a thinking process: private instructions"}}]}\n\n'
        + 'data: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ))
      .mockResolvedValueOnce(new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: post } }] })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(new NextRequest("http://localhost/api/ai/generate", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
        "idempotency-key": "studio_qwen_think_leak_regression_1",
      },
      body: JSON.stringify({
        command: "write",
        input: "Создай оригинальный пост строго по теме приказа Рослесхоза от 07.04.2026 N 198",
        channelId: 42,
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
    }));
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    const serialized = JSON.stringify(events);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(serialized).not.toContain("<think>");
    expect(serialized).not.toContain("thinking process");
    expect(events).toContainEqual(expect.objectContaining({
      type: "fallback",
      fromEngine: "navy-qwen-3-6",
      toEngine: "navy-gpt-5-4",
      reason: "empty_generation",
    }));
    expect(events).toContainEqual(expect.objectContaining({ type: "replace", text: post }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "done",
      engine: "navy-gpt-5-4",
      requestedEngine: "navy-qwen-3-6",
      fallbackUsed: true,
    }));
    expect(mocks.stageGenerationArtifact).toHaveBeenCalledWith(expect.objectContaining({ text: post }));
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
        { error: { code: "provider_access_denied" } },
        { status: 403 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await (await POST(studioRequest())).text();
    await (await POST(studioRequest())).text();
    errorLog.mockRestore();

    const headers = fetchMock.mock.calls.map((call) => new Headers(call[1]?.headers));
    const keys = headers.map((item) => item.get("idempotency-key"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(keys[0]).toMatch(/^[a-f0-9]{64}:reasoning-none$/u);
    expect(keys[1]).toMatch(/^[a-f0-9]{64}:reasoning-none$/u);
    expect(keys[1]).not.toBe(keys[0]);
    expect(headers[1].get("x-request-id")).not.toBe(headers[0].get("x-request-id"));
    expect(mocks.stageAiUsageResult).not.toHaveBeenCalled();
    expect(mocks.commitAiUsageResult).not.toHaveBeenCalled();
  });
});
