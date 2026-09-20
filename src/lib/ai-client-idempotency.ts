import { captureProjectFetch } from "./project-transport";
export interface AiClientRequestIdentity {
  fingerprint: string;
  key: string;
}

/**
 * Reuses one idempotency key while the exact serialized request is being recovered.
 * A deliberate input/settings/channel change starts a distinct logical generation.
 */
export function stableAiClientRequest(
  previous: AiClientRequestIdentity | null | undefined,
  fingerprint: string,
  createKey: () => string = () => crypto.randomUUID(),
): AiClientRequestIdentity {
  if (previous?.fingerprint === fingerprint) return previous;
  return { fingerprint, key: createKey() };
}

export class AiTerminalAckError extends Error {
  constructor(
    public readonly status: number | null,
    public readonly requestId: string | null,
    public readonly retryable: boolean,
  ) {
    super("ai terminal acknowledgement failed");
    this.name = "AiTerminalAckError";
  }
}

function waitForAckRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(done, Math.max(0, delayMs));
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      globalThis.clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Commits quota only after the caller has parsed `done` and clean NDJSON EOF. */
export async function acknowledgeAiTerminal(
  key: string,
  options: {
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    retryDelaysMs?: readonly number[];
  } = {},
): Promise<{ requestId: string | null; replayed: boolean; generationResultId: number }> {
  if (!/^[A-Za-z0-9:_-]{8,96}$/u.test(key)) throw new TypeError("invalid AI request key");
  const fetchImpl = options.fetchImpl ?? captureProjectFetch();
  const retryDelaysMs = options.retryDelaysMs ?? [250, 750];
  let lastError = new AiTerminalAckError(null, null, true);

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl("/api/ai/generate/ack", {
        method: "POST",
        headers: { "idempotency-key": key },
        signal: options.signal,
      });
    } catch (error) {
      if ((error as Error)?.name === "AbortError") throw error;
      lastError = new AiTerminalAckError(null, null, true);
      if (attempt === retryDelaysMs.length) throw lastError;
      await waitForAckRetry(retryDelaysMs[attempt] ?? 0, options.signal);
      continue;
    }
    const payload = await response.json().catch(() => null) as {
      ok?: boolean;
      requestId?: string;
      replayed?: boolean;
      generationResultId?: number;
      retryable?: boolean;
      retryAfterSeconds?: number;
    } | null;
    const requestId = payload?.requestId ?? response.headers.get("x-ai-request-id");
    const acknowledged = response.ok
      && payload?.ok === true
      && response.headers.get("x-ai-acknowledged") === "true"
      && Number.isSafeInteger(payload.generationResultId)
      && Number(payload.generationResultId) > 0;
    if (acknowledged) {
      return {
        requestId,
        replayed: payload?.replayed === true,
        generationResultId: Number(payload?.generationResultId),
      };
    }

    lastError = new AiTerminalAckError(
      response.status,
      requestId,
      payload?.retryable === true || response.status >= 500,
    );
    if (!lastError.retryable || attempt === retryDelaysMs.length) throw lastError;
    const retryAfterMs = Number.isFinite(payload?.retryAfterSeconds)
      ? Math.min(2_000, Math.max(0, Number(payload?.retryAfterSeconds) * 1_000))
      : 0;
    await waitForAckRetry(Math.max(retryDelaysMs[attempt] ?? 0, retryAfterMs), options.signal);
  }

  throw lastError;
}
