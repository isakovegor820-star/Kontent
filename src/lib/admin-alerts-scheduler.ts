import {
  AdminAlertTracker,
  adminAlertsConfig,
  deliverAdminAlerts,
  evaluateAdminAlertConditions,
} from "./admin-alerts";
import { getPool } from "./db";
import type { Pool } from "pg";
import type { probeRedisAndPublicationWorker } from "./readiness-probes";

const SCHEDULER_KEY = Symbol.for("aurora.admin-alerts.scheduler");
type SchedulerGlobal = typeof globalThis & { [SCHEDULER_KEY]?: { stop: () => void } };

/** One bounded scheduler evaluation, also exercised with an isolated DB/fake provider. */
export async function runAdminAlertsTick(input: {
  pool: Pick<Pool, "query">;
  tracker: AdminAlertTracker;
  env: Record<string, string | undefined>;
  probe?: typeof probeRedisAndPublicationWorker;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}) {
  const conditions = await evaluateAdminAlertConditions({ pool: input.pool, overdueThreshold: adminAlertsConfig(input.env).overdueThreshold, probe: input.probe });
  const notifications = await input.tracker.transition(conditions, input.nowMs);
  const delivery = await deliverAdminAlerts({ ...input, notifications });
  return { notifications: notifications.map((item) => `${item.id}:${item.kind}`), ...delivery };
}

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

  const tracker = new AdminAlertTracker({ pool: getPool(), repeatMs: config.repeatMs });
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const pool = getPool();
      const result = await runAdminAlertsTick({ pool, tracker, env });
      if (result.notifications.length > 0) console.info("[admin-alerts]", result);
    } catch (error) {
      console.error("[admin-alerts]", { code: "tick_failed", errorName: error instanceof Error ? error.name : "Error" });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), config.intervalMs);
  timer.unref?.();
  // Evaluate shortly after boot; external monitoring must cover database/web outages.
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
