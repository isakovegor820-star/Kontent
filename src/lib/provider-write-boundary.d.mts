import type { ProviderId, ProviderReadinessState } from "./provider-capabilities.mjs";

export interface ProviderLiveWriteBoundary {
  readonly allowed: boolean;
  readonly terminal: boolean;
  readonly retryable: false;
  readonly providerId: ProviderId | null;
  readonly state: ProviderReadinessState;
  readonly error: string | null;
  readonly code: string | null;
  readonly message: string | null;
  readonly exportAvailable: boolean;
}

export function resolveProviderLiveWriteBoundary(providerId: unknown): ProviderLiveWriteBoundary;
