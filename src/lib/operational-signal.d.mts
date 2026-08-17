export const OPERATIONAL_SIGNAL_EVENTS: Readonly<{
  deliveryUnknown: "delivery_unknown";
  recoveryFailed: "recovery_failed";
  telegramRejected: "telegram_rejected";
  uploadBusy: "upload_busy";
}>;

export type OperationalSignalInput = {
  event: (typeof OPERATIONAL_SIGNAL_EVENTS)[keyof typeof OPERATIONAL_SIGNAL_EVENTS];
  surface?: string;
  errorName?: string;
  requestId?: string;
  projectId?: number;
  entityId?: number;
  count?: number;
  retryAfterSeconds?: number;
};

export type OperationalSignal = {
  marker: "aurora_operational_signal";
  schemaVersion: 1;
  occurredAt: string;
  event: OperationalSignalInput["event"];
  severity: "error" | "warning";
  component: "audience_delivery" | "media_upload";
  surface?: string;
  errorName?: string;
  requestId?: string;
  projectId?: number;
  entityId?: number;
  count?: number;
  retryAfterSeconds?: number;
};

export function buildOperationalSignal(
  input: OperationalSignalInput,
  now?: Date,
): OperationalSignal;

export function emitOperationalSignal(
  input: OperationalSignalInput,
  options?: {
    now?: Date;
    logger?: Pick<Console, "error" | "warn">;
  },
): OperationalSignal;
