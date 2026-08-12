import { resolveProviderLiveWriteBoundary } from "../src/lib/provider-write-boundary.mjs";

/**
 * Converts a shared provider boundary into a durable worker failure. A terminal
 * result must never enter the generic retry branch because no external delivery
 * was attempted and no future retry can succeed without a product/config change.
 */
export function providerTerminalFailure(providerId) {
  const boundary = resolveProviderLiveWriteBoundary(providerId);
  if (boundary.allowed || !boundary.terminal) return null;
  return Object.freeze({
    providerId: boundary.providerId,
    status: "failed",
    terminal: true,
    retryable: false,
    error: boundary.error,
    errorCode: boundary.code,
    reason: boundary.message,
    livePublished: false,
    exportAvailable: boundary.exportAvailable,
  });
}
