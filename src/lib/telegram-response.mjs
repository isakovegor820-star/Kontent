/**
 * Never manufacture a provider rejection from unreadable HTTP/JSON. The caller
 * knows whether this was a read (temporary failure) or a write (unknown delivery).
 */
export async function readTelegramResponse(response) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw Object.assign(new Error("telegram_response_invalid"), { code: "telegram_response_invalid" });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || typeof payload.ok !== "boolean"
    || (payload.ok === false && !validErrorCode(payload.error_code))
    || (payload.ok === true && Number(response.status) >= 400)) {
    throw Object.assign(new Error("telegram_response_invalid"), { code: "telegram_response_invalid" });
  }
  return payload;
}

function validErrorCode(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599;
}

export function classifyTelegramDelivery(response, { messageCount = 1, group = false } = {}) {
  if (response?.ok === false && validErrorCode(response.error_code)) {
    const seconds = Number(response.parameters?.retry_after);
    return {
      kind: "rejected",
      providerErrorCode: response.error_code,
      retryAfterSeconds: response.error_code === 429 && Number.isFinite(seconds) && seconds > 0
        ? Math.ceil(seconds) : null,
    };
  }
  if (response?.ok !== true) return { kind: "unknown" };
  const messages = group ? response.result : [response.result];
  if (!Array.isArray(messages) || messages.length !== messageCount) return { kind: "unknown" };
  const messageIds = messages.map((message) => message?.message_id);
  if (messageIds.some((id) => typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)
    || new Set(messageIds).size !== messageCount) return { kind: "unknown" };
  return { kind: "accepted", messageIds };
}
