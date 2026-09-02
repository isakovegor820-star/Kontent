import {
  AdminAlertTracker,
  adminAlertsConfig,
  deliverAdminAlerts,
  evaluateAdminAlertConditions,
} from "./admin-alerts";
import { getPool } from "./db";

const SCHEDULER_KEY = Symbol.for("aurora.admin-alerts.scheduler");
type SchedulerGlobal = typeof globalThis & { [SCHEDULER_KEY]?: { stop: () => void } };

/**
 * Runs in the web process: the worker cannot report its own death, and the web process
 * is the only long-lived runtime that is still up when Redis or the worker is not.
 * Idempotent per process; disabled during builds, tests and with AURORA_ADMIN_ALERTS=off.
 */
export function startAdminAlertsScheduler(
  env: Record<string, string | undefined> = process.env,
): { stop: () => void } | null {
  const scope = globalThis as SchedulerGlobal;
  if (scope[SCHEDULER_KEY]) return scope[SCHEDULER_KEY];
  const config = adminAlertsConfig(env);
  if (!config.enabled) return null;
  if (env.NEXT_PHASE === "phase-production-build" || env.NODE_ENV === "test" || env.VITEST) return null;
  if (env.AURORA_RUNTIME_ROLE && env.AURORA_RUNTIME_ROLE !== "web") return null;

  const tracker = new AdminAlertTracker({ repeatMs: config.repeatMs });
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const pool = getPool();
      const conditions = await evaluateAdminAlertConditions({ pool, overdueThreshold: config.overdueThreshold });
      const notifications = tracker.transition(conditions);
      if (notifications.length > 0) {
        const delivery = await deliverAdminAlerts({ pool, notifications, env });
        console.info("[admin-alerts]", { notifications: notifications.map((item) => `${item.id}:${item.kind}`), ...delivery });
      }
    } catch (error) {
      console.error("[admin-alerts]", { code: "tick_failed", errorName: error instanceof Error ? error.name : "Error" });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), config.intervalMs);
  timer.unref?.();
  // First evaluation shortly after boot so a broken deploy is reported within a minute.
  const initial = setTimeout(() => void tick(), Math.min(60_000, config.intervalMs));
  initial.unref?.();
  const handle = {
    stop: () => {
      clearInterval(timer);
      clearTimeout(initial);
      delete scope[SCHEDULER_KEY];
    },
  };
  scope[SCHEDULER_KEY] = handle;
  return handle;
}
