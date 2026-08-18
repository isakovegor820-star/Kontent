// Telegram polling has a different liveness contract from publication delivery.
// A publication-only worker may be perfectly healthy while never reading a single bot update.

export const TELEGRAM_POLLING_HEARTBEAT_KEY = "aurora:worker:telegram-polling:heartbeat:v1";
export const TELEGRAM_POLLING_HEARTBEAT_TTL_SECONDS = 75;
export const TELEGRAM_POLLING_HEARTBEAT_ROLE = "telegram_polling";
export const TELEGRAM_POLLING_STATES = Object.freeze(["up", "conflict"]);

export function workerModeHasTelegramPolling(mode) {
  const normalized = String(mode ?? "").trim().toLowerCase();
  return !["autopilot", "media", "publication"].includes(normalized);
}

export function telegramPollingEnabled({ mode, token }) {
  return workerModeHasTelegramPolling(mode)
    && Boolean(String(token || "").trim());
}

export function telegramPollingHeartbeatPayload(atMs = Date.now(), state = "up") {
  const timestamp = Number(atMs);
  if (!Number.isFinite(timestamp)) throw new TypeError("telegram polling heartbeat requires a valid time");
  if (!TELEGRAM_POLLING_STATES.includes(state)) {
    throw new TypeError("telegram polling heartbeat requires a valid state");
  }
  return {
    version: 1,
    role: TELEGRAM_POLLING_HEARTBEAT_ROLE,
    state,
    at: new Date(timestamp).toISOString(),
  };
}

export function telegramPollingHeartbeatWrite(input, atMs = Date.now()) {
  if (!telegramPollingEnabled(input)) return null;
  return {
    key: TELEGRAM_POLLING_HEARTBEAT_KEY,
    value: JSON.stringify(telegramPollingHeartbeatPayload(atMs, input.state)),
    ttlSeconds: TELEGRAM_POLLING_HEARTBEAT_TTL_SECONDS,
  };
}

export function parseTelegramPollingHeartbeat(
  raw,
  { nowMs = Date.now(), maxAgeMs = TELEGRAM_POLLING_HEARTBEAT_TTL_SECONDS * 1000 } = {},
) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (Object.keys(value).sort().join(",") !== "at,role,state,version") return null;
    if (
      value.version !== 1
      || value.role !== TELEGRAM_POLLING_HEARTBEAT_ROLE
      || !TELEGRAM_POLLING_STATES.includes(value.state)
      || typeof value.at !== "string"
    ) return null;
    const heartbeatMs = Date.parse(value.at);
    const currentMs = Number(nowMs);
    const allowedAgeMs = Number(maxAgeMs);
    if (!Number.isFinite(heartbeatMs) || !Number.isFinite(currentMs) || !Number.isFinite(allowedAgeMs)) {
      return null;
    }
    if (new Date(heartbeatMs).toISOString() !== value.at) return null;
    const ageMs = currentMs - heartbeatMs;
    if (ageMs < -10_000 || ageMs >= allowedAgeMs) return null;
    return { version: 1, role: TELEGRAM_POLLING_HEARTBEAT_ROLE, state: value.state, at: value.at };
  } catch {
    return null;
  }
}
