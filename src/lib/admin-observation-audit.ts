import type { Pool } from "pg";

type Queryable = Pick<Pool, "query">;

export type AdminObservationAction = "admin.system.read" | "admin.aurora_analytics.read";
export type AdminObservationTarget = "runtime" | "project" | "section" | "component";

const SAFE_KEYS = new Set([
  "range", "from", "to", "projectId", "segment", "tenure", "device",
  "appVersion", "release", "sectionId", "tab",
]);
const SAFE_VALUE = /^[A-Za-z0-9._:/+-]{1,128}$/u;

function safeFilters(filters: Record<string, unknown> | undefined): Record<string, string | number | null> {
  const result: Record<string, string | number | null> = {};
  for (const [key, value] of Object.entries(filters ?? {})) {
    if (!SAFE_KEYS.has(key)) continue;
    if (value === null) result[key] = null;
    else if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) result[key] = value;
    else if (typeof value === "string" && SAFE_VALUE.test(value)) result[key] = value;
  }
  return result;
}

export async function recordAdminObservation(input: {
  db: Queryable;
  actorUserId: number;
  action: AdminObservationAction;
  targetType: AdminObservationTarget;
  targetId?: string | number | null;
  requestId?: string | null;
  filters?: Record<string, unknown>;
}): Promise<boolean> {
  if (!Number.isSafeInteger(input.actorUserId) || input.actorUserId <= 0) return false;
  const targetId: string | null = input.targetType === "runtime" ? null : String(input.targetId ?? "");
  if (input.targetType !== "runtime" && (targetId === null || !/^[A-Za-z0-9._:-]{1,128}$/u.test(targetId))) return false;
  const requestId = input.requestId && /^[A-Za-z0-9._:-]{1,128}$/u.test(input.requestId) ? input.requestId : null;
  try {
    await input.db.query(
      `insert into admin_observation_events
         (actor_user_id, action, target_type, target_id, request_id, safe_filters)
       values ($1,$2,$3,$4,$5,$6::jsonb)`,
      [input.actorUserId, input.action, input.targetType, targetId, requestId, JSON.stringify(safeFilters(input.filters))],
    );
    return true;
  } catch (error) {
    console.error("[admin-observation-audit] write failed", {
      action: input.action,
      errorName: error instanceof Error ? error.name : "Error",
    });
    return false;
  }
}
