export interface PasswordResetDelivery {
  ok: boolean;
  code?: "not_configured" | "provider_error" | "network_error";
}
export function passwordResetDeliveryConfigured(env?: NodeJS.ProcessEnv): boolean;
export function deliverPasswordResetEmail(
  input: { to: string; resetUrl: string; idempotencyKey: string },
  options?: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch },
): Promise<PasswordResetDelivery>;
