export const AUDIENCE_DELIVERY_LEASE_SECONDS: number;
export const AUDIENCE_DELIVERY_ERROR_CODES: Readonly<{
  unknown: "delivery_unknown";
  rejected: "telegram_rejected";
}>;
export const AUDIENCE_STALE_PROJECT_DELIVERIES_SQL: string;
export const AUDIENCE_STALE_ALL_DELIVERIES_SQL: string;
export const AUDIENCE_STALE_DELIVERY_CAS_SQL: string;
export const AUDIENCE_FAIL_DELIVERY_SQL: string;
export const AUDIENCE_FINISH_DELIVERY_SQL: string;

export function audienceDeliveryLeaseExpired(
  providerStartedAt: unknown,
  nowMs?: number,
): boolean;

export type AudienceTelegramDeliveryOutcome =
  | { kind: "delivered"; externalMessageId: number }
  | { kind: "rejected" }
  | { kind: "unknown" };

export function classifyAudienceTelegramResponse(
  response: unknown,
): AudienceTelegramDeliveryOutcome;
