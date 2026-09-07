import assert from "node:assert/strict";
import { validateAuroraProductEventDraft } from "../src/lib/product-event-contract.mjs";

const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const uuid = value => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value);

// Capture the actual wire batch before navigation or mutable test fixtures can
// change it. Invalid or unavailable request metadata supplies no evidence.
export function captureProductEventBatch(request, actorUserId, nowMs) {
  try {
    const headers = request.headers(); const text = request.postData();
    if (!positiveId(actorUserId) || !/^[1-9][0-9]*$/u.test(headers["x-aurora-project-id"] ?? "")
      || !positiveId(headers["x-aurora-project-id"]) || headers["content-type"]?.split(";")[0] !== "application/json"
      || typeof text !== "string" || Buffer.byteLength(text) > 65_536) return null;
    const body = JSON.parse(text);
    if (!body || Object.keys(body).length !== 1 || !Array.isArray(body.events) || body.events.length < 1 || body.events.length > 50) return null;
    const validated = body.events.map(event => validateAuroraProductEventDraft(event, { nowMs }));
    if (validated.some(event => !event.ok)) return null;
    const events = validated.map(result => result.event);
    if (new Set(events.map(event => event.eventId)).size !== events.length) return null;
    return { actorUserId: Number(actorUserId), projectId: Number(headers["x-aurora-project-id"]), events };
  } catch { return null; }
}

// This proves the idempotent effects, not a received HTTP response or absence of
// dispatch. Missing/partial/different rows must remain unknown; no retry occurs.
export function assertProductEventPersistence(batch, receipts) {
  assert(batch && Array.isArray(receipts) && receipts.length === batch.events.length, "product-event batch lacks complete receipts");
  for (const event of batch.events) {
    const matches = receipts.filter(row => row.event_id === event.eventId);
    assert(matches.length === 1, "product-event receipt identity is not unique");
    const row = matches[0];
    assert(positiveId(row.id) && Number(row.user_id) === batch.actorUserId && Number(row.project_id) === batch.projectId,
      "product-event receipt actor/project mismatch");
    const fields = { sectionId: "section_id", featureId: "feature_id", action: "action", stage: "stage", outcome: "outcome",
      durationMs: "duration_ms", errorCode: "error_code", operationId: "operation_id", sessionId: "session_id", important: "important" };
    for (const [field, column] of Object.entries(fields)) assert.deepEqual(row[column], event[field], "product-event receipt payload mismatch");
    assert.deepEqual(row.safe_context, event.safeContext, "product-event context mismatch");
    assert(new Date(row.occurred_at).toISOString() === event.occurredAt, "product-event time mismatch");
    assert(event.requestId ? row.request_id === event.requestId : uuid(row.request_id), "product-event correlation mismatch");
  }
  return receipts.length;
}
