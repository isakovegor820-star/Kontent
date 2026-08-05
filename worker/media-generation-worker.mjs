// Side-effect-free orchestration for one BullMQ media attempt. PostgreSQL, NavyAI,
// downloads and reservation leases are injected by worker.mjs so every paid-call path
// can be exercised without Redis, a real database, or provider credentials.

const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503]);

export class MediaGenerationAttemptError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "MediaGenerationAttemptError";
    this.code = String(code || "worker_failed");
    this.httpStatus = Number(options.httpStatus || 0) || null;
    this.retryable = RETRYABLE_HTTP_STATUSES.has(this.httpStatus);
  }
}

export function mediaErrorForAttempt(error) {
  if (error instanceof MediaGenerationAttemptError) return error;
  const httpStatus = Number(error?.httpStatus || error?.status || 0) || null;
  const known = error && typeof error === "object" && typeof error.code === "string";
  return new MediaGenerationAttemptError(
    known ? error.code : "worker_failed",
    known && typeof error.message === "string"
      ? error.message.slice(0, 300)
      : "Не удалось создать медиафайл. Запусти генерацию ещё раз.",
    { httpStatus },
  );
}

export function isRetryableMediaError(error) {
  const status = Number(error?.httpStatus || error?.status || 0);
  return RETRYABLE_HTTP_STATUSES.has(status);
}

function terminalError(code, message) {
  return new MediaGenerationAttemptError(code, message);
}

async function claimConfirmedGeneration(job, deps, options) {
  let lastPending = null;
  for (let attempt = 0; attempt < options.handoffPollAttempts; attempt += 1) {
    const claim = await deps.store.claim(job);
    if (claim.state !== "handoff_pending") return claim;
    lastPending = claim;
    await deps.wait(options.handoffPollMs);
  }
  return {
    state: "rejected",
    generation: lastPending?.generation || null,
    error: terminalError(
      "queue_unconfirmed",
      "Очередь не подтвердила задачу. Запусти генерацию ещё раз.",
    ),
  };
}

/**
 * Executes exactly one BullMQ attempt. The store must atomically claim only a confirmed
 * queued row backed by a live reserved usage row. It owns all durable transitions.
 */
export async function executeMediaGenerationJob(job, deps, config = {}) {
  const options = {
    handoffPollAttempts: Math.max(1, Number(config.handoffPollAttempts || 20)),
    handoffPollMs: Math.max(0, Number(config.handoffPollMs ?? 100)),
    pollIntervalMs: Math.max(0, Number(config.pollIntervalMs ?? 4_000)),
    pollDeadlineMs: Math.max(1, Number(config.pollDeadlineMs || 9 * 60_000)),
  };
  let claim;
  try {
    claim = await claimConfirmedGeneration(job, deps, options);
  } catch {
    const claimError = new MediaGenerationAttemptError(
      "claim_unavailable",
      "Не удалось безопасно получить задачу генерации. Аврора повторит попытку.",
      { httpStatus: 503 },
    );
    if (job.finalAttempt === true) {
      await deps.store.failByJobIdentity?.(job, claimError);
    }
    throw claimError;
  }
  if (claim.state === "skip") return { outcome: "skipped", reason: claim.reason || "not_eligible" };
  if (claim.state === "rejected") {
    const rejected = mediaErrorForAttempt(claim.error || terminalError(
      "generation_not_eligible",
      "Задача больше не может быть выполнена. Запусти генерацию ещё раз.",
    ));
    if (claim.generation) await deps.store.failAndRelease(claim.generation, rejected);
    throw rejected;
  }
  if (claim.state !== "claimed" || !claim.generation) {
    throw terminalError("claim_failed", "Не удалось безопасно начать генерацию.");
  }

  const generation = claim.generation;
  let lease = null;
  try {
    lease = await deps.lease.start(generation);
    if (!lease) {
      throw terminalError(
        "reservation_unavailable",
        "Резерв генерации больше не действует. Запусти задачу ещё раз.",
      );
    }
    await lease.assertActive();

    let providerJobId = String(generation.provider_job_id || "").trim();
    if (!providerJobId) {
      const created = await deps.provider.create({
        payload: deps.buildPayload(generation),
        requestKey: generation.provider_request_key,
        requestId: generation.request_id,
        signal: lease.signal,
      });
      await lease.assertActive();
      if (created.state === "completed" && created.outputUrl) {
        await deps.store.persistResult(generation, created.outputUrl, lease);
        return { outcome: "ready", providerJobId: null };
      }
      providerJobId = String(created.providerJobId || "").trim();
      if (!providerJobId) {
        throw terminalError("bad_provider_response", "NavyAI не вернул идентификатор генерации.");
      }
      await deps.store.markGenerating(generation, providerJobId);
    } else {
      await deps.store.markGenerating(generation, providerJobId);
    }

    const deadline = deps.now() + options.pollDeadlineMs;
    while (deps.now() < deadline) {
      await deps.wait(options.pollIntervalMs);
      await lease.assertActive();
      const result = await deps.provider.poll({
        providerJobId,
        requestId: generation.request_id,
        signal: lease.signal,
      });
      if (result.state === "completed" && result.outputUrl) {
        await lease.assertActive();
        await deps.store.persistResult(generation, result.outputUrl, lease);
        return { outcome: "ready", providerJobId };
      }
    }
    throw terminalError(
      "timed_out",
      "Генерация заняла слишком много времени. Запусти её ещё раз позже.",
    );
  } catch (error) {
    const attemptError = mediaErrorForAttempt(error);
    if (isRetryableMediaError(attemptError) && job.finalAttempt !== true) {
      await deps.store.requeue(generation, attemptError);
    } else {
      await deps.store.failAndRelease(generation, attemptError);
    }
    throw attemptError;
  } finally {
    await lease?.stop?.();
  }
}
