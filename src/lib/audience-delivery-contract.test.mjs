import { describe, expect, it } from "vitest";

import {
  AUDIENCE_DELIVERY_LEASE_SECONDS,
  AUDIENCE_FAIL_DELIVERY_SQL,
  AUDIENCE_FINISH_DELIVERY_SQL,
  AUDIENCE_STALE_DELIVERY_CAS_SQL,
  AUDIENCE_STALE_ALL_DELIVERIES_SQL,
  AUDIENCE_STALE_PROJECT_DELIVERIES_SQL,
  audienceDeliveryLeaseExpired,
  classifyAudienceTelegramResponse,
} from "./audience-delivery-contract.mjs";

describe("audience delivery contract", () => {
  it("classifies only a positive acknowledgement with a message id as delivered", () => {
    expect(classifyAudienceTelegramResponse({ ok: true, result: { message_id: 72 } }))
      .toEqual({ kind: "delivered", externalMessageId: 72 });
    expect(classifyAudienceTelegramResponse({ ok: false, error_code: 400 }))
      .toEqual({ kind: "rejected" });
    for (const malformed of [null, {}, { ok: true }, { ok: true, result: {} }, { ok: true, result: { message_id: 0 } }]) {
      expect(classifyAudienceTelegramResponse(malformed)).toEqual({ kind: "unknown" });
    }
  });

  it("uses one bounded lease and CAS-protected state transitions", () => {
    expect(AUDIENCE_DELIVERY_LEASE_SECONDS).toBe(120);
    expect(audienceDeliveryLeaseExpired(
      "2026-08-16T10:00:00.000Z",
      Date.parse("2026-08-16T10:02:00.000Z"),
    )).toBe(true);
    expect(AUDIENCE_STALE_PROJECT_DELIVERIES_SQL).toContain("audience.reply.delivery_failed");
    expect(AUDIENCE_STALE_PROJECT_DELIVERIES_SQL).toContain("returning entity_id as id");
    expect(AUDIENCE_STALE_ALL_DELIVERIES_SQL).toContain("for update skip locked");
    expect(AUDIENCE_STALE_ALL_DELIVERIES_SQL).toContain("limit $2");
    expect(AUDIENCE_STALE_ALL_DELIVERIES_SQL).toContain("worker_recovery");
    expect(AUDIENCE_STALE_DELIVERY_CAS_SQL).toContain("version = $3");
    expect(AUDIENCE_FAIL_DELIVERY_SQL).toContain("delivery_request_key = $3");
    expect(AUDIENCE_FAIL_DELIVERY_SQL).toContain("'surface', $6::text");
    expect(AUDIENCE_FINISH_DELIVERY_SQL).toContain("status = 'sent'");
    expect(AUDIENCE_FINISH_DELIVERY_SQL).toContain("audience.reply.sent");
    expect(AUDIENCE_FINISH_DELIVERY_SQL).toContain("delivery_request_key = $3");
  });
});
