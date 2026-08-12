import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  hasTrustedMutationOrigin: vi.fn(),
  navyMediaCapabilities: vi.fn(),
  acquireAiUsageRequest: vi.fn(),
  releaseAiUsage: vi.fn(),
  reconcileStaleMediaGeneration: vi.fn(),
  channelAiContextFor: vi.fn(),
  poolQuery: vi.fn(),
  txQuery: vi.fn(),
  txRelease: vi.fn(),
  hasMediaWorker: vi.fn(),
  enqueueMediaGeneration: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/request-origin", () => ({
  hasTrustedMutationOrigin: mocks.hasTrustedMutationOrigin,
}));
vi.mock("@/lib/navy-media.mjs", () => ({
  navyMediaCapabilities: mocks.navyMediaCapabilities,
}));
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

import { POST } from "@/app/api/media/generations/route";
import { executeMediaGenerationJob } from "../../worker/media-generation-worker.mjs";

type QuotaState = "none" | "reserved" | "committed" | "released";
type GenerationStatus = "queued" | "submitting" | "generating" | "saving" | "ready" | "failed";

type GenerationRow = {
  id: number;
  user_id: number;
  project_id: number;
  request_id: string;
  request_key: string;
  provider_request_key: string;
  provider_job_id: string | null;
  ai_usage_reservation_id: number;
  kind: "image";
  status: GenerationStatus;
  prompt: string;
  negative_prompt: string | null;
  prompt_context: Record<string, unknown>;
  source_text: string;
  exact_text: string;
  model: string;
  aspect_ratio: string;
  quality: string;
  seconds: null;
  style: string;
  output_asset_id: number | null;
  mime_type: string | null;
  bytes: number | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
};

type Ledger = {
  quota: QuotaState;
  generation: GenerationRow | null;
  queueConfirmed: boolean;
  queuedJob: Record<string, unknown> | null;
  transitions: GenerationStatus[];
};

const USER_ID = 7;
const PROJECT_ID = 5;
const CHANNEL_ID = 18;
const RESERVATION_ID = 91;
const GENERATION_ID = 41;

let ledger: Ledger;

function generationRequest(requestKey: string) {
  return new NextRequest("http://localhost/api/media/generations", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      "content-type": "application/json",
      "idempotency-key": requestKey,
    },
    body: JSON.stringify({
      kind: "image",
      prompt: "Редакционная иллюстрация о правовой технологии",
      sourceText: "Пост о проверяемом изменении в праве",
      exactText: "",
      negativePrompt: "без водяных знаков",
      model: "nano-banana-2",
      aspectRatio: "1:1",
      quality: "medium",
      style: "editorial",
      channelId: CHANNEL_ID,
    }),
  });
}

function publicRow(row: GenerationRow): GenerationRow {
  const context = row.prompt_context;
  return {
    ...row,
    source_text: String(context.sourcePost ?? ""),
    exact_text: String(context.exactText ?? ""),
  };
}

function configureStatefulInfrastructure() {
  mocks.acquireAiUsageRequest.mockImplementation(async () => {
    if (ledger.quota !== "none") throw new Error("unexpected second quota reservation");
    ledger.quota = "reserved";
    return {
      allowed: true,
      used: 1,
      limit: 30,
      reservationId: RESERVATION_ID,
      requestState: "acquired",
    };
  });
  mocks.releaseAiUsage.mockImplementation(async () => {
    if (ledger.quota !== "reserved") return false;
    ledger.quota = "released";
    return true;
  });
  mocks.enqueueMediaGeneration.mockImplementation(async (job: Record<string, unknown>) => {
    ledger.queuedJob = structuredClone(job);
    return { jobId: `media-${String(job.generationId)}`, recovered: false };
  });
  mocks.txQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [], rowCount: 0 };
    if (sql.includes("select id from users")) return { rows: [{ id: USER_ID }], rowCount: 1 };
    if (sql.includes("returning ai_usage_reservation_id")) return { rows: [], rowCount: 0 };
    if (sql.includes("count(*) filter")) return { rows: [{ used: "0", active: "0" }], rowCount: 1 };
    if (sql.includes("insert into media_generations")) {
      const values = params ?? [];
      const now = new Date("2026-08-05T10:00:00.000Z");
      ledger.generation = {
        id: GENERATION_ID,
        user_id: Number(values[0]),
        project_id: Number(values[1]),
        kind: String(values[2]) as "image",
        prompt: String(values[3]),
        negative_prompt: values[4] == null ? null : String(values[4]),
        model: String(values[5]),
        aspect_ratio: String(values[6]),
        quality: String(values[7]),
        seconds: null,
        style: String(values[9]),
        request_key: String(values[12]),
        ai_usage_reservation_id: Number(values[13]),
        request_id: String(values[14]),
        provider_request_key: String(values[15]),
        provider_job_id: null,
        prompt_context: values[17] as Record<string, unknown>,
        source_text: "",
        exact_text: "",
        status: "queued",
        output_asset_id: null,
        mime_type: null,
        bytes: null,
        error_code: null,
        error_message: null,
        created_at: now,
        updated_at: now,
        completed_at: null,
      };
      ledger.transitions.push("queued");
      return { rows: [{ id: GENERATION_ID }], rowCount: 1 };
    }
    throw new Error(`unexpected transaction query: ${sql}`);
  });
  mocks.poolQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes("from user_project_preferences preference")) {
      return {
        rows: [{
          project_id: PROJECT_ID,
          user_id: USER_ID,
          role: "author",
          version: 1,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("where g.project_id = $1 and g.request_key = $2")) {
      const matches = ledger.generation
        && ledger.generation.project_id === Number(params?.[0])
        && ledger.generation.request_key === String(params?.[1]);
      return { rows: matches ? [publicRow(ledger.generation!)] : [], rowCount: matches ? 1 : 0 };
    }
    if (sql.includes("set queue_confirmed_at = now()")) {
      ledger.queueConfirmed = true;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("where g.id = $1 and g.user_id = $2")) {
      const matches = ledger.generation
        && ledger.generation.id === Number(params?.[0])
        && ledger.generation.user_id === Number(params?.[1]);
      return { rows: matches ? [publicRow(ledger.generation!)] : [], rowCount: matches ? 1 : 0 };
    }
    throw new Error(`unexpected pool query: ${sql}`);
  });
}

function workerHarness(providerCreate: () => Promise<Record<string, unknown>>) {
  const provider = {
    create: vi.fn(providerCreate),
    poll: vi.fn(async () => ({ state: "pending", outputUrl: null })),
  };
  const lease = {
    signal: new AbortController().signal,
    assertActive: vi.fn(async () => ledger.quota === "reserved"),
    stop: vi.fn(async () => {}),
  };
  const store = {
    claim: vi.fn(async () => {
      const generation = ledger.generation;
      if (!generation || !ledger.queueConfirmed || generation.status !== "queued" || ledger.quota !== "reserved") {
        return { state: "skip", reason: "not_eligible" };
      }
      generation.status = "submitting";
      ledger.transitions.push("submitting");
      return { state: "claimed", generation };
    }),
    markGenerating: vi.fn(async (generation: GenerationRow, providerJobId: string) => {
      generation.provider_job_id = providerJobId;
      generation.status = "generating";
      ledger.transitions.push("generating");
    }),
    persistResult: vi.fn(async (generation: GenerationRow) => {
      generation.status = "saving";
      ledger.transitions.push("saving");
      generation.output_asset_id = 501;
      generation.mime_type = "image/png";
      generation.bytes = 68;
      generation.status = "ready";
      generation.completed_at = new Date("2026-08-05T10:00:05.000Z");
      ledger.transitions.push("ready");
      ledger.quota = "committed";
    }),
    requeue: vi.fn(async () => {
      if (ledger.generation) ledger.generation.status = "queued";
    }),
    failAndRelease: vi.fn(async (generation: GenerationRow, error: { code?: string; message?: string }) => {
      generation.status = "failed";
      generation.error_code = error.code ?? "worker_failed";
      generation.error_message = error.message ?? "Не удалось создать изображение";
      generation.completed_at = new Date("2026-08-05T10:00:05.000Z");
      ledger.transitions.push("failed");
      ledger.quota = "released";
    }),
  };
  return {
    provider,
    store,
    deps: {
      store,
      provider,
      lease: { start: vi.fn(async () => lease) },
      buildPayload: vi.fn(() => ({ model: "nano-banana-2", prompt: "internal prompt" })),
      now: () => 0,
      wait: vi.fn(async () => {}),
    },
  };
}

describe("authenticated media API to worker terminal contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NAVYAI_API_KEY", "disposable-e2e-key");
    ledger = {
      quota: "none",
      generation: null,
      queueConfirmed: false,
      queuedJob: null,
      transitions: [],
    };
    mocks.getSessionUser.mockResolvedValue({ id: USER_ID });
    mocks.hasTrustedMutationOrigin.mockReturnValue(true);
    mocks.hasMediaWorker.mockResolvedValue(true);
    mocks.navyMediaCapabilities.mockResolvedValue({ checked: false, models: [] });
    mocks.reconcileStaleMediaGeneration.mockResolvedValue({ reconciled: [], released: [] });
    mocks.channelAiContextFor.mockResolvedValue({
      network: "tg",
      profile: "Юридический сервис; палитра #6750A4",
      profileProvenance: {
        niche: { value: "Правовые технологии" },
        tone: { value: "Спокойный экспертный" },
      },
    });
    configureStatefulInfrastructure();
  });

  afterEach(() => vi.unstubAllEnvs());

  it("commits quota only after ready and replays the same terminal generation", async () => {
    const requestKey = "media-e2e-success-0001";
    const accepted = await POST(generationRequest(requestKey));
    const acceptedBody = await accepted.json();

    expect(accepted.status).toBe(202);
    expect(acceptedBody).toMatchObject({
      requestId: expect.any(String),
      generation: { id: String(GENERATION_ID), status: "queued" },
    });
    expect(accepted.headers.get("x-request-id")).toBe(acceptedBody.requestId);
    expect(ledger.quota).toBe("reserved");
    expect(ledger.queuedJob).toMatchObject({
      generationId: GENERATION_ID,
      projectId: PROJECT_ID,
      requestKey,
    });

    const worker = workerHarness(async () => ({
      state: "completed",
      outputUrl: "data:image/png;base64,iVBORw0KGgo=",
      providerJobId: null,
    }));
    await expect(executeMediaGenerationJob(
      { ...ledger.queuedJob, finalAttempt: false },
      worker.deps,
    )).resolves.toEqual({ outcome: "ready", providerJobId: null });

    expect(ledger.transitions).toEqual(["queued", "submitting", "saving", "ready"]);
    expect(ledger.generation?.status).toBe("ready");
    expect(ledger.quota).toBe("committed");
    expect(worker.provider.create).toHaveBeenCalledOnce();

    const replay = await POST(generationRequest(requestKey));
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      replayed: true,
      requestId: acceptedBody.requestId,
      generation: { id: String(GENERATION_ID), status: "ready", assetId: "501" },
    });
    expect(mocks.acquireAiUsageRequest).toHaveBeenCalledOnce();
    expect(mocks.enqueueMediaGeneration).toHaveBeenCalledOnce();
    expect(worker.provider.create).toHaveBeenCalledOnce();
  });

  it("releases quota on terminal provider rejection and never exposes ready", async () => {
    const requestKey = "media-e2e-failure-0001";
    const accepted = await POST(generationRequest(requestKey));
    expect(accepted.status).toBe(202);

    const worker = workerHarness(async () => {
      throw Object.assign(new Error("Безопасное отклонение провайдера"), {
        code: "provider_rejected",
        httpStatus: 422,
      });
    });
    await expect(executeMediaGenerationJob(
      { ...ledger.queuedJob, finalAttempt: false },
      worker.deps,
    )).rejects.toMatchObject({ code: "provider_rejected", retryable: false });

    expect(ledger.transitions).toEqual(["queued", "submitting", "failed"]);
    expect(ledger.generation?.status).toBe("failed");
    expect(ledger.generation?.output_asset_id).toBeNull();
    expect(ledger.quota).toBe("released");
    expect(worker.store.persistResult).not.toHaveBeenCalled();

    const replay = await POST(generationRequest(requestKey));
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      replayed: true,
      generation: { status: "failed", errorCode: "provider_rejected" },
    });
    expect(mocks.acquireAiUsageRequest).toHaveBeenCalledOnce();
    expect(worker.provider.create).toHaveBeenCalledOnce();
  });
});
