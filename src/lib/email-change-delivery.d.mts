export interface EmailChangeDeliveryResult {
  ok: boolean;
  code?: "not_configured" | "provider_error" | "network_error";
}

export function emailChangeDeliveryConfigured(env?: NodeJS.ProcessEnv): boolean;
export function deliverEmailChangeEmail(
  input: { to: string; confirmUrl: string; idempotencyKey: string },
  options?: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch },
): Promise<EmailChangeDeliveryResult>;
