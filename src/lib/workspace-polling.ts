export const WORKSPACE_POLL_MS = 8_000;

export type WorkspaceVisibilitySource = {
  readonly hidden: boolean;
  addEventListener: (type: "visibilitychange", listener: () => void) => void;
  removeEventListener: (type: "visibilitychange", listener: () => void) => void;
};

type WorkspacePollingInput = {
  refreshReal: () => void | Promise<void>;
  refreshAiUsage: () => void | Promise<void>;
  visibility: WorkspaceVisibilitySource;
  intervalMs?: number;
};

export function isWorkspacePollingRoute(pathname: string | null): boolean {
  return pathname === "/app" || Boolean(pathname?.startsWith("/app/"));
}

/**
 * Keeps workspace data fresh only while the product UI is actually visible.
 * Public/auth routes never create this controller; hidden tabs release both timers.
 */
export function startVisibleWorkspacePolling({
  refreshReal,
  refreshAiUsage,
  visibility,
  intervalMs = WORKSPACE_POLL_MS,
}: WorkspacePollingInput): () => void {
  const delay = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : WORKSPACE_POLL_MS;
  let realTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  let aiTimer: ReturnType<typeof globalThis.setInterval> | null = null;

  const stopTimers = () => {
    if (realTimer !== null) globalThis.clearInterval(realTimer);
    if (aiTimer !== null) globalThis.clearInterval(aiTimer);
    realTimer = null;
    aiTimer = null;
  };

  const startTimers = () => {
    stopTimers();
    if (visibility.hidden) return;

    void refreshReal();
    void refreshAiUsage();
    realTimer = globalThis.setInterval(() => void refreshReal(), delay);
    aiTimer = globalThis.setInterval(() => void refreshAiUsage(), delay);
  };

  const onVisibilityChange = () => startTimers();
  visibility.addEventListener("visibilitychange", onVisibilityChange);
  startTimers();

  return () => {
    visibility.removeEventListener("visibilitychange", onVisibilityChange);
    stopTimers();
  };
}
