import { workerModeHasTelegramPolling } from "./telegram-polling-heartbeat.mjs";

/** Separate Redis instances cannot arbitrate ownership of the same Telegram token. */
export function telegramPollingRuntimeEnabled(env = process.env) {
  if (!workerModeHasTelegramPolling(env.AURORA_WORKER_MODE) || !String(env.TG_BOT_TOKEN || "").trim()) return false;
  const explicit = String(env.TG_POLLING_ENABLED || "").trim();
  if (explicit) return explicit === "1";
  return env.NODE_ENV === "production";
}
