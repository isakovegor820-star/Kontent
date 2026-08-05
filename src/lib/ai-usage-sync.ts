export const AI_USAGE_POLL_MS = 8_000;

export type AiUsageStatus = "loading" | "ok" | "unknown";

export type AiUsageMetrics = {
  used: number;
  limit: number;
  left: number;
  ratio: number;
  hot: boolean;
  exhausted: boolean;
};

export type ParsedAiUsage =
  | { status: "ok"; used: number; limit: number }
  | { status: "unknown" };

/**
 * The UI may show quota numbers only after a successful, structurally valid server response.
 * A transport error, 503, or malformed payload is an unknown counter — never an implied zero.
 */
export function parseAiUsageResponse(responseOk: boolean, value: unknown): ParsedAiUsage {
  if (!responseOk || !value || typeof value !== "object") return { status: "unknown" };

  const payload = value as { status?: unknown; used?: unknown; limit?: unknown };
  if (
    payload.status !== "ok"
    || typeof payload.used !== "number"
    || !Number.isFinite(payload.used)
    || payload.used < 0
    || typeof payload.limit !== "number"
    || !Number.isFinite(payload.limit)
    || payload.limit <= 0
  ) {
    return { status: "unknown" };
  }

  return { status: "ok", used: payload.used, limit: payload.limit };
}

/** Returns display/preflight values only while the shared counter is known. */
export function getAiUsageMetrics(
  status: AiUsageStatus,
  used: number,
  limit: number,
): AiUsageMetrics | null {
  if (
    status !== "ok"
    || !Number.isFinite(used)
    || used < 0
    || !Number.isFinite(limit)
    || limit <= 0
  ) {
    return null;
  }

  const ratio = Math.min(1, used / limit);
  return {
    used,
    limit,
    left: Math.max(0, limit - used),
    ratio,
    hot: ratio >= 0.9,
    exhausted: used >= limit,
  };
}

/**
 * Every open tab polls the server-side counter. This avoids relying on localStorage events,
 * which do not fire in the tab that made the generation and can be disabled independently.
 */
export function startAiUsagePolling(
  refresh: () => void | Promise<void>,
  intervalMs = AI_USAGE_POLL_MS,
): () => void {
  const delay = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : AI_USAGE_POLL_MS;
  const timer = globalThis.setInterval(() => {
    void refresh();
  }, delay);
  return () => globalThis.clearInterval(timer);
}
