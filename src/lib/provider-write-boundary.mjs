import {
  PROVIDER_CREDENTIAL_STATES,
  PROVIDER_PERMISSION_STATES,
  providerSupportsOperation,
  resolveProviderOperation,
} from "./provider-capabilities.mjs";

/**
 * Shared API/worker preflight for live provider writes. Readiness inputs are set to
 * ready deliberately: this boundary answers whether product/API support exists at all.
 * Credential health remains a separate runtime check for supported providers.
 */
export function resolveProviderLiveWriteBoundary(providerId) {
  const readiness = resolveProviderOperation(providerId, "livePublish", {
    credentialState: PROVIDER_CREDENTIAL_STATES.READY,
    permissionState: PROVIDER_PERMISSION_STATES.READY,
  });
  if (readiness.available) {
    return Object.freeze({
      allowed: true,
      terminal: false,
      retryable: false,
      providerId: readiness.providerId,
      state: readiness.state,
      error: null,
      code: null,
      message: null,
      exportAvailable: providerSupportsOperation(providerId, "exportPackage"),
    });
  }

  const officialAccessRequired = readiness.state === "official_access_required";
  const normalizedProvider = readiness.providerId || null;
  return Object.freeze({
    allowed: false,
    terminal: true,
    retryable: false,
    providerId: normalizedProvider,
    state: readiness.state,
    error: officialAccessRequired ? "official_access_required" : "provider_operation_unsupported",
    code: officialAccessRequired && normalizedProvider
      ? `${normalizedProvider}_official_access_required`
      : readiness.reason || "provider_operation_unsupported",
    message: readiness.message || "Автопубликация для этой площадки недоступна.",
    exportAvailable: providerSupportsOperation(providerId, "exportPackage"),
  });
}
