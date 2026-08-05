export interface MediaPollScheduler {
  setInterval(callback: () => void, delay: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

/** Runs once synchronously, then on a non-overlapping interval. */
export function startImmediateMediaPolling(
  poll: () => Promise<void>,
  intervalMs: number,
  scheduler: MediaPollScheduler,
): () => void {
  let stopped = false;
  let inFlight = false;
  const run = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await poll();
    } finally {
      inFlight = false;
    }
  };
  void run();
  const timer = scheduler.setInterval(() => { void run(); }, intervalMs);
  return () => {
    stopped = true;
    scheduler.clearInterval(timer);
  };
}

/** Keep the same logical request after an ambiguous or server-side outcome. */
export function shouldRetainMediaRequestKey(status: number, error?: string | null): boolean {
  return status >= 500
    || error === "request_in_progress"
    || error === "usage_unavailable"
    || error === "provider_unavailable"
    || error === "worker_unavailable";
}

export function mediaElapsedLabel(startedAt: string, now = Date.now()): string {
  const start = new Date(startedAt).getTime();
  const seconds = Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1000)) : 0;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}:${String(remainder).padStart(2, "0")}` : `${seconds} сек`;
}
