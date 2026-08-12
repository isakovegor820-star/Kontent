import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  hasTrustedMutationOrigin: vi.fn(),
  validateMediaInput: vi.fn(),
  buildMediaPromptContext: vi.fn(),
  navyMediaCapabilities: vi.fn(),
  acquireAiUsageRequest: vi.fn(),
  reconcileStaleMediaGeneration: vi.fn(),
  channelAiContextFor: vi.fn(),
  releaseAiUsage: vi.fn(),
  poolQuery: vi.fn(),
  txQuery: vi.fn(),
  txRelease: vi.fn(),
  hasMediaWorker: vi.fn(),
  enqueueMediaGeneration: vi.fn(),
  requireSelectedProjectPermission: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: mocks.hasTrustedMutationOrigin }));
vi.mock("@/lib/media-generation.mjs", () => ({
  validateMediaInput: mocks.validateMediaInput,
  buildMediaPromptContext: mocks.buildMediaPromptContext,
  MEDIA_PROMPT_POLICY: { version: 3 },
}));
vi.mock("@/lib/navy-media.mjs", () => ({ navyMediaCapabilities: mocks.navyMediaCapabilities }));
vi.mock("@/lib/media-generation-reconciliation", () => ({
  reconcileStaleMediaGeneration: mocks.reconcileStaleMediaGeneration,
}));
vi.mock("@/lib/ai-usage", () => ({
  AI_DAILY_LIMIT: 30,
  acquireAiUsageRequest: mocks.acquireAiUsageRequest,
  releaseAiUsage: mocks.releaseAiUsage,
  channelAiContextFor: mocks.channelAiContextFor,
}));
vi.mock("@/lib/db", () => ({
  getPool: () => ({
    query: mocks.poolQuery,
    connect: vi.fn(async () => ({ query: mocks.txQuery, release: mocks.txRelease })),
  }),
}));
vi.mock("@/lib/queue", () => ({
  hasMediaWorker: mocks.hasMediaWorker,
  enqueueMediaGeneration: mocks.enqueueMediaGeneration,
}));
vi.mock("@/lib/project-permissions", () => ({
  ProjectAccessError: class ProjectAccessError extends Error {},
  requireSelectedProjectPermission: mocks.requireSelectedProjectPermission,
}));

import { POST } from "./route";

const input = {
  kind: "image",
  prompt: "Редакционная иллюстрация",
  negativePrompt: "",
  model: "nano-banana-2",
  aspectRatio: "1:1",
  quality: "medium",
  seconds: null,
  style: "editorial",
  niche: "",
  tone: "",
  channelId: 18,
};

const generation = {
  id: 41,
  request_id: "11111111-1111-4111-8111-111111111111",
  kind: "image",
  status: "queued",
  prompt: input.prompt,
  negative_prompt: "без водяных знаков",
  source_text: "Исходный пост",
  exact_text: "Точный текст",
  model: "nano-banana-2",
  aspect_ratio: "1:1",
  quality: "medium",
  seconds: null,
  style: "editorial",
  output_asset_id: null,
  mime_type: null,
  bytes: null,
  error_code: null,
  error_message: null,
  created_at: new Date("2026-08-01T00:00:00Z"),
  updated_at: new Date("2026-08-01T00:00:00Z"),
  completed_at: null,
  queue_confirmed_at: new Date("2026-08-01T00:00:01Z"),
};

function request(key?: string) {
  return new NextRequest("http://localhost/api/media/generations", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      "content-type": "application/json",
      ...(key ? { "idempotency-key": key } : {}),
    },
    body: JSON.stringify(input),
  });
}

describe("POST /api/media/generations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NAVYAI_API_KEY", "test-key");
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.requireSelectedProjectPermission.mockResolvedValue({
      projectId: 23,
      userId: 7,
      role: "author",
      version: 1,
    });
    mocks.hasTrustedMutationOrigin.mockReturnValue(true);
    mocks.poolQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    mocks.validateMediaInput.mockReturnValue({ ok: true, value: input });
    mocks.buildMediaPromptContext.mockReturnValue({
      policy: "aurora-media-prompt",
      version: 1,
      visualBrief: input.prompt,
    });
    mocks.hasMediaWorker.mockResolvedValue(true);
    mocks.enqueueMediaGeneration.mockResolvedValue({ recovered: false, jobId: "media-41" });
    mocks.navyMediaCapabilities.mockResolvedValue({ checked: false, models: [] });
    mocks.reconcileStaleMediaGeneration.mockResolvedValue({ reconciled: [], released: [] });
    mocks.acquireAiUsageRequest.mockResolvedValue({
      allowed: true,
      used: 4,
      limit: 30,
      reservationId: 91,
      requestState: "acquired",
    });
    mocks.channelAiContextFor.mockResolvedValue({
      profileProvenance: {
        niche: { value: "Правовые технологии" },
        tone: { value: "Деловой" },
      },
      quality: {
        visualDirection: "Лаконичная юридическая инфографика",
        visualDetail: 88,
      },
    });
    mocks.releaseAiUsage.mockResolvedValue(true);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("requires a stable idempotency key before reserving quota", async () => {
    const response = await POST(request());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "idempotency_key_required",
      requestId: expect.any(String),
    });
    expect(mocks.acquireAiUsageRequest).not.toHaveBeenCalled();
  });

  it("replays a durable generation without another quota or queue operation", async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [generation] });

    const response = await POST(request("media_retry_1234"));

    expect(response.status).toBe(202);
    expect((await response.json()).replayed).toBe(true);
    expect(mocks.acquireAiUsageRequest).not.toHaveBeenCalled();
    expect(mocks.enqueueMediaGeneration).not.toHaveBeenCalled();
    expect(mocks.reconcileStaleMediaGeneration).toHaveBeenCalledWith(
      expect.anything(),
      { userId: 7, projectId: 23, requestKey: "media_retry_1234" },
    );
    expect(mocks.poolQuery).toHaveBeenCalledWith(
      expect.stringContaining("where g.project_id = $1 and g.request_key = $2"),
      [23, "media_retry_1234"],
    );
  });

  it("releases the shared reservation when Redis cannot accept the job", async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    mocks.txQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("returning ai_usage_reservation_id")) return { rows: [] };
      if (sql.includes("count(*) filter")) return { rows: [{ used: "0", active: "0" }] };
      if (sql.includes("insert into media_generations")) return { rows: [{ id: 41 }] };
      return { rows: [], rowCount: 1 };
    });
    mocks.enqueueMediaGeneration.mockRejectedValueOnce(new Error("redis unavailable"));

    const response = await POST(request("media_retry_5678"));

    expect(response.status).toBe(503);
    expect(mocks.acquireAiUsageRequest).toHaveBeenCalledWith(
      7,
      "media-image",
      expect.objectContaining({
        reservationKey: "media:media_retry_5678",
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        operationId: expect.any(String),
      }),
    );
    expect(mocks.releaseAiUsage).toHaveBeenCalledWith(7, 91);
  });

  it("rejects an unowned channel before quota reservation", async () => {
    mocks.channelAiContextFor.mockResolvedValueOnce(null);
    const response = await POST(request("media_channel_owner"));
    expect(response.status).toBe(404);
    expect(mocks.acquireAiUsageRequest).not.toHaveBeenCalled();
  });

  it("stores only server-side effective channel context, never client demo context", async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rows: [generation] });
    mocks.txQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("insert into media_generations")) return { rows: [{ id: 41 }] };
      if (sql.includes("count(*) filter")) return { rows: [{ used: "0", active: "0" }] };
      return { rows: [], rowCount: 1 };
    });
    const response = await POST(request("media_context_1234"));
    expect(response.status).toBe(202);
    expect(mocks.buildMediaPromptContext).toHaveBeenCalledWith(
      input,
      expect.objectContaining({
        visualDirection: "Лаконичная юридическая инфографика",
        visualDetail: 88,
      }),
    );
    const insertion = mocks.txQuery.mock.calls.find(([sql]) => String(sql).includes("insert into media_generations"));
    expect(insertion?.[1]?.[1]).toBe(23);
    expect(insertion?.[1]).toEqual(expect.arrayContaining(["Правовые технологии", "Деловой"]));
    expect(insertion?.[1]).not.toContain("кофе");
    expect(mocks.enqueueMediaGeneration).toHaveBeenCalledWith(expect.objectContaining({
      generationId: 41,
      projectId: 23,
    }));
  });

  it("fails closed before quota reservation when no media worker is present", async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
    mocks.hasMediaWorker.mockResolvedValueOnce(false);

    const response = await POST(request("media_no_worker_1234"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "worker_unavailable",
      requestId: expect.any(String),
    });
    expect(mocks.acquireAiUsageRequest).not.toHaveBeenCalled();
    expect(mocks.enqueueMediaGeneration).not.toHaveBeenCalled();
  });

  it("returns the persisted correlation id on replay", async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [generation] });

    const response = await POST(request("media_request_id_1234"));

    expect(response.headers.get("x-request-id")).toBe(generation.request_id);
    expect(await response.json()).toMatchObject({
      requestId: generation.request_id,
      generation: {
        requestId: generation.request_id,
        negativePrompt: generation.negative_prompt,
        sourceText: generation.source_text,
        exactText: generation.exact_text,
      },
    });
  });

  it("does not release quota when queue confirmation committed but its DB response was lost", async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error("confirmation ACK lost"))
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [generation], rowCount: 1 });
    mocks.txQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("insert into media_generations")) return { rows: [{ id: 41 }] };
      if (sql.includes("count(*) filter")) return { rows: [{ used: "0", active: "0" }] };
      return { rows: [], rowCount: 1 };
    });

    const response = await POST(request("media_confirm_ack_lost"));

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ replayed: true, generation: { id: "41" } });
    expect(mocks.releaseAiUsage).not.toHaveBeenCalled();
  });

  it("reuses a released usage row and rejects a changed payload fingerprint", async () => {
    mocks.acquireAiUsageRequest.mockResolvedValueOnce({
      allowed: false,
      used: 0,
      limit: 30,
      reservationId: 91,
      requestState: "conflict",
      result: null,
    });

    const response = await POST(request("media_released_retry"));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "idempotency_key_conflict", retryable: false });
    expect(mocks.enqueueMediaGeneration).not.toHaveBeenCalled();
  });
});
