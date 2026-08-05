import { describe, expect, it, vi } from "vitest";

import { deliverEmailChangeEmail, emailChangeDeliveryConfigured } from "./email-change-delivery.mjs";

describe("email change delivery", () => {
  it("fails closed when email delivery is not configured", async () => {
    expect(emailChangeDeliveryConfigured({})).toBe(false);
    await expect(deliverEmailChangeEmail({
      to: "new@example.test",
      confirmUrl: "https://aurora.example/confirm-email#token=secret",
      idempotencyKey: "email-change-1",
    }, { env: {}, fetchImpl: vi.fn() })).resolves.toEqual({ ok: false, code: "not_configured" });
  });

  it("uses a provider idempotency key and does not place the token in headers", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(init.headers["idempotency-key"]).toBe("email-change-17");
      expect(JSON.stringify(init.headers)).not.toContain("one-time-secret");
      expect(JSON.parse(init.body).text).toContain("#token=one-time-secret");
      return { ok: true };
    });
    await expect(deliverEmailChangeEmail({
      to: "new@example.test",
      confirmUrl: "https://aurora.example/confirm-email#token=one-time-secret",
      idempotencyKey: "email-change-17",
    }, {
      env: { RESEND_API_KEY: "provider-key", EMAIL_CHANGE_FROM: "Aurora <no-reply@example.test>" },
      fetchImpl,
    })).resolves.toEqual({ ok: true });
  });
});
