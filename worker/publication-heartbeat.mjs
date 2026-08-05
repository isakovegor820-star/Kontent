// Pure contract for the publication worker readiness heartbeat.
// Runtime Redis writes live in worker.mjs; this module is safe to import in tests/web code.

export const PUBLICATION_HEARTBEAT_KEY = "aurora:worker:publication:heartbeat:v1";
export const PUBLICATION_HEARTBEAT_TTL_SECONDS = 30;
export const PUBLICATION_HEARTBEAT_INTERVAL_MS = 10_000;
export const PUBLICATION_HEARTBEAT_ROLE = "publication";

/** Mirrors worker.mjs mode selection: only a process with the publish Worker may claim readiness. */
export function workerModeHasPublication(mode) {
  const normalized = String(mode ?? "").trim().toLowerCase();
  return normalized !== "media" && normalized !== "autopilot";
}

export function publicationHeartbeatPayload(atMs = Date.now()) {
  const timestamp = Number(atMs);
  if (!Number.isFinite(timestamp)) throw new TypeError("publication heartbeat requires a valid time");
  return {
    version: 1,
    role: PUBLICATION_HEARTBEAT_ROLE,
    at: new Date(timestamp).toISOString(),
  };
}

export function serializePublicationHeartbeat(atMs = Date.now()) {
  return JSON.stringify(publicationHeartbeatPayload(atMs));
}

/** Pure Redis SET contract. A non-publication worker receives no command at all. */
export function publicationHeartbeatWrite(mode, atMs = Date.now()) {
  if (!workerModeHasPublication(mode)) return null;
  return {
    key: PUBLICATION_HEARTBEAT_KEY,
    value: serializePublicationHeartbeat(atMs),
    ttlSeconds: PUBLICATION_HEARTBEAT_TTL_SECONDS,
  };
}

/**
 * Strict parser for a future web readiness route. Redis TTL is the primary liveness signal;
 * the embedded timestamp prevents a manually persisted or malformed value from reporting ready.
 */
export function parsePublicationHeartbeat(
  raw,
  { nowMs = Date.now(), maxAgeMs = PUBLICATION_HEARTBEAT_TTL_SECONDS * 1000 } = {},
) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Object.keys(value).sort();
    if (keys.join(",") !== "at,role,version") return null;
    if (value.version !== 1 || value.role !== PUBLICATION_HEARTBEAT_ROLE || typeof value.at !== "string") {
      return null;
    }
    const heartbeatMs = Date.parse(value.at);
    const currentMs = Number(nowMs);
    const allowedAgeMs = Number(maxAgeMs);
    if (!Number.isFinite(heartbeatMs) || !Number.isFinite(currentMs) || !Number.isFinite(allowedAgeMs)) {
      return null;
    }
    if (new Date(heartbeatMs).toISOString() !== value.at) return null;
    const ageMs = currentMs - heartbeatMs;
    // Allow one cadence of clock skew between the web and worker hosts.
    if (ageMs < -PUBLICATION_HEARTBEAT_INTERVAL_MS || ageMs >= allowedAgeMs) return null;
    return { version: 1, role: PUBLICATION_HEARTBEAT_ROLE, at: value.at };
  } catch {
    return null;
  }
}
