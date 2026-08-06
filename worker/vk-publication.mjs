import { createHash } from "node:crypto";

export const PROVIDER_OUTCOMES = Object.freeze({
  SUCCESS: "success",
  DEFINITE_FAILURE: "definite_failure",
  DELIVERY_UNKNOWN: "delivery_unknown",
  RATE_LIMITED: "rate_limited",
  AUTH_FAILED: "auth_failed",
});

export function vkProviderOperationIdentity({ postId, revision }) {
  const id = Number(postId);
  const rev = Number(revision);
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(rev) || rev <= 0) {
    throw new TypeError("vk_provider_identity_invalid");
  }
  return createHash("sha256").update(`aurora:vk:post:${id}:revision:${rev}`).digest("hex").slice(0, 32);
}

export function classifyVkApiError(error) {
  const code = Number(error?.error_code);
  if (code === 5 || code === 27 || code === 28) {
    return { outcome: PROVIDER_OUTCOMES.AUTH_FAILED, code: `vk_auth_${code}` };
  }
  if (code === 6 || code === 9 || code === 29) {
    return { outcome: PROVIDER_OUTCOMES.RATE_LIMITED, code: `vk_rate_limited_${code}` };
  }
  if (code === 7 || code === 15 || code === 200 || code === 203) {
    return { outcome: PROVIDER_OUTCOMES.AUTH_FAILED, code: `vk_permission_${code}` };
  }
  return {
    outcome: PROVIDER_OUTCOMES.DEFINITE_FAILURE,
    code: Number.isFinite(code) ? `vk_api_${code}` : "vk_api_error",
  };
}

/** request(method, params, token) must return parsed VK JSON and may throw on transport. */
export async function publishVkWithRequest({ request, token, groupId, message, providerOperationId }) {
  let response;
  try {
    response = await request("wall.post", {
      owner_id: `-${groupId}`,
      from_group: 1,
      message,
      guid: providerOperationId,
    }, token);
  } catch (error) {
    return {
      ok: false,
      outcome: PROVIDER_OUTCOMES.DELIVERY_UNKNOWN,
      deliveryUnknown: true,
      errorCode: /timeout|abort/iu.test(String(error?.name || error?.message || ""))
        ? "vk_transport_timeout"
        : "vk_transport_reset",
      providerOperationId,
    };
  }
  if (response?.error) {
    const classified = classifyVkApiError(response.error);
    return {
      ok: false,
      ...classified,
      deliveryUnknown: false,
      reason: String(response.error.error_msg || classified.code),
      providerOperationId,
    };
  }
  const postId = Number(response?.response?.post_id);
  if (Number.isSafeInteger(postId) && postId > 0) {
    return {
      ok: true,
      outcome: PROVIDER_OUTCOMES.SUCCESS,
      postId,
      providerOperationId,
    };
  }
  // An invalid/missing success body does not prove that VK rejected the write.
  return {
    ok: false,
    outcome: PROVIDER_OUTCOMES.DELIVERY_UNKNOWN,
    deliveryUnknown: true,
    errorCode: "vk_success_unconfirmed",
    providerOperationId,
  };
}

export async function reconcileVkWithRequest({
  request,
  token,
  groupId,
  message,
  providerStartedAt,
  windowMs = 15 * 60_000,
}) {
  let response;
  try {
    response = await request("wall.get", { owner_id: `-${groupId}`, count: 100, filter: "owner" }, token);
  } catch {
    return { outcome: PROVIDER_OUTCOMES.DELIVERY_UNKNOWN, state: "unresolved", errorCode: "vk_reconcile_transport" };
  }
  if (response?.error) {
    const classified = classifyVkApiError(response.error);
    return { ...classified, state: "unresolved" };
  }
  const startedAt = new Date(providerStartedAt).getTime();
  if (!Number.isFinite(startedAt)) {
    return { outcome: PROVIDER_OUTCOMES.DEFINITE_FAILURE, state: "unresolved", errorCode: "vk_reconcile_time_invalid" };
  }
  const items = Array.isArray(response?.response?.items)
    ? response.response.items
    : Array.isArray(response?.response)
      ? response.response
      : [];
  const matches = items.filter((item) => {
    const publishedAt = Number(item?.date) * 1000;
    return Number.isSafeInteger(Number(item?.id))
      && String(item?.text || "") === String(message || "")
      && Number.isFinite(publishedAt)
      && Math.abs(publishedAt - startedAt) <= windowMs;
  });
  if (matches.length === 1) {
    return {
      outcome: PROVIDER_OUTCOMES.SUCCESS,
      state: "confirmed",
      postId: Number(matches[0].id),
    };
  }
  return {
    outcome: PROVIDER_OUTCOMES.DELIVERY_UNKNOWN,
    state: "unresolved",
    errorCode: matches.length > 1 ? "vk_reconcile_ambiguous" : "vk_reconcile_not_found",
  };
}
