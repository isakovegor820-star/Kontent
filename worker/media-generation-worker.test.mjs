import { describe, expect, it, vi } from "vitest";
import {
  executeMediaGenerationJob,
  isRetryableMediaError,
  MediaGenerationAttemptError,
} from "./media-generation-worker.mjs";

const generation = {
  id: 41,
  user_id: 7,
  kind: "image",
  status: "submitting",
  request_id: "11111111-1111-4111-8111-111111111111",
  request_key: "media_client_key_1234",
  provider_request_key: "aurora-media-11111111-1111-4111-8111-111111111111",
  provider_job_id: null,
  ai_usage_reservation_id: 91,
};

function harness(overrides = {}) {
  let clock = 0;
  const store = {
    claim: vi.fn(async () => ({ state: "claimed", generation: { ...generation } })),
    markGenerating: vi.fn(async () => {}),
    persistResult: vi.fn(async () => {}),
    requeue: vi.fn(async () => {}),
    failAndRelease: vi.fn(async () => {}),
    failByJobIdentity: vi.fn(async () => {}),
    ...overrides.store,
  };
  const provider = {
    create: vi.fn(async () => ({ state: "completed", outputUrl: "data:image/png;base64,iVBORw0KGgo=", providerJobId: null })),
    poll: vi.fn(async () => ({ state: "pending", outputUrl: null })),
    ...overrides.provider,
  };
  const leaseSession = {
    signal: new AbortController().signal,
    assertActive: vi.fn(async () => true),
    stop: vi.fn(async () => {}),
  };
  const deps = {
    store,
    provider,
    lease: {
      start: vi.fn(async () => leaseSession),
      ...overrides.lease,
    },
    buildPayload: vi.fn(() => ({ model: "nano-banana-2", prompt: "hidden" })),
    now: () => clock,
    wait: vi.fn(async (ms) => { clock += ms; }),
  };
  return { deps, store, provider, leaseSession };
}

describe("media generation worker core", () => {
  it("persists an inline terminal success under the active reservation", async () => {
    const { deps, store, provider, leaseSession } = harness();

    await expect(executeMediaGenerationJob({
      generationId: 41,
      requestId: generation.request_id,
      requestKey: generation.request_key,
      finalAttempt: false,
    }, deps)).resolves.toEqual({ outcome: "ready", providerJobId: null });

    expect(provider.create).toHaveBeenCalledWith(expect.objectContaining({
      requestKey: generation.provider_request_key,
      requestId: generation.request_id,
    }));
    expect(store.persistResult).toHaveBeenCalledOnce();
    expect(store.failAndRelease).not.toHaveBeenCalled();
    expect(leaseSession.stop).toHaveBeenCalledOnce();
  });

  it("never calls Navy for a released reservation", async () => {
    const { deps, store, provider } = harness({
      store: {
        claim: vi.fn(async () => ({
          state: "rejected",
          generation: { ...generation },
          error: new MediaGenerationAttemptError(
            "reservation_unavailable",
            "Резерв генерации больше не действует.",
          ),
        })),
      },
    });

    await expect(executeMediaGenerationJob({ generationId: 41, finalAttempt: false }, deps))
      .rejects.toMatchObject({ code: "reservation_unavailable", retryable: false });
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.poll).not.toHaveBeenCalled();
    expect(deps.lease.start).not.toHaveBeenCalled();
    expect(store.failAndRelease).toHaveBeenCalledOnce();
  });

  it.each([429, 500, 502, 503])("requeues only retryable provider HTTP %s", async (httpStatus) => {
    const { deps, store } = harness({
      provider: {
        create: vi.fn(async () => {
          throw Object.assign(new Error("safe provider message"), {
            code: "provider_unavailable",
            httpStatus,
          });
        }),
      },
    });

    await expect(executeMediaGenerationJob({ generationId: 41, finalAttempt: false }, deps))
      .rejects.toMatchObject({ httpStatus, retryable: true });
    expect(store.requeue).toHaveBeenCalledOnce();
    expect(store.failAndRelease).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 404, 409, 422, 504])("fails terminally for nonretryable provider HTTP %s", async (httpStatus) => {
    const { deps, store } = harness({
      provider: {
        create: vi.fn(async () => {
          throw Object.assign(new Error("safe provider rejection"), {
            code: "provider_rejected",
            httpStatus,
          });
        }),
      },
    });

    await expect(executeMediaGenerationJob({ generationId: 41, finalAttempt: false }, deps))
      .rejects.toMatchObject({ httpStatus, retryable: false });
    expect(store.requeue).not.toHaveBeenCalled();
    expect(store.failAndRelease).toHaveBeenCalledOnce();
  });

  it("fails terminally when the provider never reaches a terminal state", async () => {
    const { deps, store, provider } = harness({
      provider: {
        create: vi.fn(async () => ({ state: "pending", providerJobId: "navy-job-8" })),
        poll: vi.fn(async () => ({ state: "pending", outputUrl: null })),
      },
    });

    await expect(executeMediaGenerationJob(
      { generationId: 41, finalAttempt: false },
      deps,
      { pollIntervalMs: 10, pollDeadlineMs: 25 },
    )).rejects.toMatchObject({ code: "timed_out", retryable: false });
    expect(provider.poll).toHaveBeenCalledTimes(3);
    expect(store.failAndRelease).toHaveBeenCalledOnce();
  });

  it("marks a retryable final attempt as failed and releases it", async () => {
    const { deps, store } = harness({
      provider: {
        create: vi.fn(async () => {
          throw Object.assign(new Error("limited"), {
            code: "provider_rate_limited",
            httpStatus: 429,
          });
        }),
      },
    });

    await expect(executeMediaGenerationJob({ generationId: 41, finalAttempt: true }, deps))
      .rejects.toMatchObject({ retryable: true });
    expect(store.requeue).not.toHaveBeenCalled();
    expect(store.failAndRelease).toHaveBeenCalledOnce();
  });

  it("uses the exact retry status allowlist", () => {
    expect(isRetryableMediaError({ httpStatus: 429 })).toBe(true);
    expect(isRetryableMediaError({ httpStatus: 503 })).toBe(true);
    expect(isRetryableMediaError({ httpStatus: 504, retryable: true })).toBe(false);
    expect(isRetryableMediaError({ retryable: true })).toBe(false);
  });

  it("retries a transient claim failure and terminalizes it on the final attempt", async () => {
    const first = harness({
      store: { claim: vi.fn(async () => { throw new Error("database unavailable"); }) },
    });
    await expect(executeMediaGenerationJob({ generationId: 41, finalAttempt: false }, first.deps))
      .rejects.toMatchObject({ code: "claim_unavailable", retryable: true });
    expect(first.store.failByJobIdentity).not.toHaveBeenCalled();
    expect(first.provider.create).not.toHaveBeenCalled();

    const final = harness({
      store: { claim: vi.fn(async () => { throw new Error("database unavailable"); }) },
    });
    const job = {
      generationId: 41,
      requestId: generation.request_id,
      requestKey: generation.request_key,
      providerRequestKey: generation.provider_request_key,
      finalAttempt: true,
    };
    await expect(executeMediaGenerationJob(job, final.deps))
      .rejects.toMatchObject({ code: "claim_unavailable", retryable: true });
    expect(final.store.failByJobIdentity).toHaveBeenCalledWith(
      job,
      expect.objectContaining({ code: "claim_unavailable" }),
    );
    expect(final.provider.create).not.toHaveBeenCalled();
  });
});

describe("опрос провайдера переживает сетевые сбои", () => {
  // Замер октября 2026: 4 из 9 генераций не собрались с первого раза, потому что
  // GET-опрос не уложился в 30 секунд, хотя у провайдера файл уже был готов.
  // Раньше такой таймаут был терминальным и платная генерация падала навсегда.
  it("продолжает опрос после таймаута и сохраняет готовый файл", async () => {
    let polls = 0;
    const { deps, store } = harness({
      provider: {
        create: vi.fn(async () => ({ state: "pending", outputUrl: null, providerJobId: "job-77" })),
        poll: vi.fn(async () => {
          polls += 1;
          if (polls === 1) throw new MediaGenerationAttemptError("provider_timeout", "NavyAI не успел ответить.");
          return { state: "completed", outputUrl: "data:image/jpeg;base64,/9j/4AAQ" };
        }),
      },
    });

    await expect(executeMediaGenerationJob({
      generationId: 41,
      requestId: generation.request_id,
      requestKey: generation.request_key,
      finalAttempt: true,
    }, deps)).resolves.toEqual({ outcome: "ready", providerJobId: "job-77" });

    expect(polls).toBe(2);
    expect(store.persistResult).toHaveBeenCalledOnce();
    expect(store.failAndRelease).not.toHaveBeenCalled();
  });

  it("не повторяет опрос после отказа модели", async () => {
    let polls = 0;
    const { deps, store } = harness({
      provider: {
        create: vi.fn(async () => ({ state: "pending", outputUrl: null, providerJobId: "job-78" })),
        poll: vi.fn(async () => {
          polls += 1;
          throw new MediaGenerationAttemptError("provider_failed", "Модель не смогла создать файл.");
        }),
      },
    });

    await expect(executeMediaGenerationJob({
      generationId: 41,
      requestId: generation.request_id,
      requestKey: generation.request_key,
      finalAttempt: true,
    }, deps)).rejects.toMatchObject({ code: "provider_failed" });

    expect(polls).toBe(1);
    expect(store.failAndRelease).toHaveBeenCalledOnce();
  });

  it("сдаётся после серии сетевых сбоев, не занимая воркер до дедлайна", async () => {
    let polls = 0;
    const { deps } = harness({
      provider: {
        create: vi.fn(async () => ({ state: "pending", outputUrl: null, providerJobId: "job-79" })),
        poll: vi.fn(async () => {
          polls += 1;
          throw new MediaGenerationAttemptError("provider_network_error", "Нет связи с NavyAI.");
        }),
      },
    });

    await expect(executeMediaGenerationJob({
      generationId: 41,
      requestId: generation.request_id,
      requestKey: generation.request_key,
      finalAttempt: true,
    }, deps, { maxConsecutiveTransientPollFailures: 3 }))
      .rejects.toMatchObject({ code: "provider_network_error" });

    expect(polls).toBe(3);
  });
});
