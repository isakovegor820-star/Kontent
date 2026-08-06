export const PROVIDER_DELIVERY_OUTCOMES = Object.freeze({
  SUCCESS: "success",
  DEFINITE_FAILURE: "definite_failure",
  DELIVERY_UNKNOWN: "delivery_unknown",
  RATE_LIMITED: "rate_limited",
  AUTH_FAILED: "auth_failed",
});

export function assertFutureProviderAdapter(adapter) {
  if (!adapter || adapter.composerSupported !== false) throw new Error("future_adapter_must_be_fail_closed");
  if (typeof adapter.publish !== "function" || typeof adapter.reconcile !== "function") {
    throw new Error("future_adapter_reconciliation_required");
  }
  if (adapter.retryPolicy !== "reconcile_before_retry") {
    throw new Error("future_adapter_retry_policy_invalid");
  }
  return true;
}

export function deliveryUnknown(providerOperationId, reason = "delivery_unknown") {
  return {
    ok: false,
    outcome: PROVIDER_DELIVERY_OUTCOMES.DELIVERY_UNKNOWN,
    deliveryUnknown: true,
    retryable: false,
    providerOperationId: providerOperationId || null,
    reason,
  };
}

export function definiteFailure(reason, {
  code = null,
  providerOperationId = null,
  retryable = false,
} = {}) {
  return {
    ok: false,
    outcome: PROVIDER_DELIVERY_OUTCOMES.DEFINITE_FAILURE,
    deliveryUnknown: false,
    retryable,
    providerOperationId,
    reason,
    code,
  };
}

export function classifiedFailure(outcome, reason, {
  code = null,
  providerOperationId = null,
  retryable = false,
} = {}) {
  if (!Object.values(PROVIDER_DELIVERY_OUTCOMES).includes(outcome) || outcome === PROVIDER_DELIVERY_OUTCOMES.SUCCESS) {
    throw new Error("provider_failure_outcome_invalid");
  }
  return {
    ok: false,
    outcome,
    deliveryUnknown: outcome === PROVIDER_DELIVERY_OUTCOMES.DELIVERY_UNKNOWN,
    retryable: outcome === PROVIDER_DELIVERY_OUTCOMES.DELIVERY_UNKNOWN ? false : retryable,
    providerOperationId,
    reason,
    code,
  };
}
