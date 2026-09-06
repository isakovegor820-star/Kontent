import type { AdminDiagnosticComponent, AdminDiagnosticState, AdminSystemDiagnostics } from "./admin-system-diagnostics";

/** One freshness rule for summary, cards, details and queue rows. */
export function diagnosticDisplayState(component: Pick<AdminDiagnosticComponent, "state" | "checkedAt" | "validUntil">, now: number, failed = false): AdminDiagnosticState {
  if (failed) return "unavailable";
  const checkedAt = Date.parse(component.checkedAt);
  const validUntil = component.validUntil ? Date.parse(component.validUntil) : checkedAt + 60_000;
  if (!Number.isFinite(checkedAt) || !Number.isFinite(validUntil) || checkedAt > now + 10_000) return "unavailable";
  return now >= validUntil ? "stale" : component.state;
}

export function isSystemDiagnostics(value: unknown): value is AdminSystemDiagnostics {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<AdminSystemDiagnostics>;
  const states = ["healthy", "degraded", "down", "unobserved", "configured", "not_configured", "conflict", "unavailable", "stale", "not_used"];
  return payload.schemaVersion === 1 && typeof payload.checkedAt === "string" && Number.isFinite(Date.parse(payload.checkedAt))
    && states.includes(String(payload.state)) && Boolean(payload.summary) && Boolean(payload.release)
    && Array.isArray(payload.components) && payload.components.length > 0
    && payload.components.every(component => typeof component.id === "string" && typeof component.label === "string"
      && states.includes(component.state) && typeof component.checkedAt === "string" && Array.isArray(component.evidence));
}
