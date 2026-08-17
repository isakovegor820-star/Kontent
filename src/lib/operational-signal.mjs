export const OPERATIONAL_SIGNAL_EVENTS = Object.freeze({
  deliveryUnknown: "delivery_unknown",
  recoveryFailed: "recovery_failed",
  telegramRejected: "telegram_rejected",
  uploadBusy: "upload_busy",
});

const DEFINITIONS = Object.freeze({
  [OPERATIONAL_SIGNAL_EVENTS.deliveryUnknown]: { severity: "error", component: "audience_delivery" },
  [OPERATIONAL_SIGNAL_EVENTS.recoveryFailed]: { severity: "error", component: "audience_delivery" },
  [OPERATIONAL_SIGNAL_EVENTS.telegramRejected]: { severity: "warning", component: "audience_delivery" },
  [OPERATIONAL_SIGNAL_EVENTS.uploadBusy]: { severity: "warning", component: "media_upload" },
});

const SAFE_LABEL = /^[a-z0-9][a-z0-9_.:-]{0,119}$/u;

function optionalLabel(value) {
  if (value == null || value === "") return undefined;
  const normalized = String(value).trim().toLowerCase();
  return SAFE_LABEL.test(normalized) ? normalized : "invalid_label";
}

function optionalInteger(value) {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized >= 0 ? normalized : undefined;
}

export function buildOperationalSignal(input, now = new Date()) {
  const event = String(input?.event || "");
  const definition = DEFINITIONS[event];
  if (!definition) throw new Error("unsupported_operational_signal");
  const occurredAt = now instanceof Date && Number.isFinite(now.getTime())
    ? now.toISOString()
    : new Date().toISOString();
  const signal = {
    marker: "aurora_operational_signal",
    schemaVersion: 1,
    occurredAt,
    event,
    severity: definition.severity,
    component: definition.component,
  };
  for (const [key, value] of [
    ["surface", optionalLabel(input.surface)],
    ["errorName", optionalLabel(input.errorName)],
    ["requestId", optionalLabel(input.requestId)],
    ["projectId", optionalInteger(input.projectId)],
    ["entityId", optionalInteger(input.entityId)],
    ["count", optionalInteger(input.count)],
    ["retryAfterSeconds", optionalInteger(input.retryAfterSeconds)],
  ]) {
    if (value !== undefined) signal[key] = value;
  }
  return signal;
}

export function emitOperationalSignal(input, options = {}) {
  const signal = buildOperationalSignal(input, options.now);
  const logger = options.logger ?? console;
  const line = `[operational_signal] ${JSON.stringify(signal)}`;
  if (signal.severity === "error") logger.error(line);
  else logger.warn(line);
  return signal;
}
