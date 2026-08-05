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

/** Commits quota only after the caller has parsed `done` and clean NDJSON EOF. */
export async function acknowledgeAiTerminal(
  key: string,
  options: {
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{ requestId: string | null; replayed: boolean }> {
  if (!/^[A-Za-z0-9:_-]{8,96}$/u.test(key)) throw new TypeError("invalid AI request key");
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl("/api/ai/generate/ack", {
      method: "POST",
      headers: { "idempotency-key": key },
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw error;
    throw new AiTerminalAckError(null, null, true);
  }
  const payload = await response.json().catch(() => null) as {
    ok?: boolean;
    requestId?: string;
    replayed?: boolean;
    retryable?: boolean;
  } | null;
  const requestId = payload?.requestId ?? response.headers.get("x-ai-request-id");
  if (!response.ok || payload?.ok !== true || response.headers.get("x-ai-acknowledged") !== "true") {
    throw new AiTerminalAckError(response.status, requestId, payload?.retryable === true || response.status >= 500);
  }
  return { requestId, replayed: payload.replayed === true };
}
