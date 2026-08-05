import { describe, expect, it } from "vitest";

import {
  findForbiddenLegalCredentialField,
  legalOperationFingerprint,
  parseLegalActionInput,
  parseLegalConnectInput,
  serializeLegalConnection,
} from "./legal-sources";

describe("legal source input policy", () => {
  it.each([
    [{ providerId: "vendor", token: "api", requestKey: "legal-key:1234", password: "secret" }, "password"],
    [{ providerId: "vendor", token: "api", requestKey: "legal-key:1234", nested: { browser_cookie: "a=b" } }, "nested.browser_cookie"],
    [{ providerId: "vendor", token: "api", requestKey: "legal-key:1234", auth: { sessionId: "secret" } }, "auth.sessionId"],
  ])("rejects browser/password credentials at %s", (input, field) => {
    expect(findForbiddenLegalCredentialField(input)).toBe(field);
    expect(parseLegalConnectInput(input)).toEqual({ ok: false, error: "forbidden_credential_field" });
  });

  it("accepts only a provider ID, API token and stable idempotency key", () => {
    expect(parseLegalConnectInput({
      providerId: "vendor-law",
      token: "official-api-token",
      requestKey: "legal-connect:1234",
    }, "legal-connect:1234")).toEqual({
      ok: true,
      value: {
        providerId: "vendor-law",
        token: "official-api-token",
        requestKey: "legal-connect:1234",
      },
    });
    expect(parseLegalConnectInput({ providerId: "vendor-law", token: "x", requestKey: "short" }))
      .toEqual({ ok: false, error: "idempotency_key_required" });
  });

  it("limits connection actions to the provider-adapter contract", () => {
    expect(parseLegalActionInput({ action: "sync", requestKey: "legal-sync:1234" }))
      .toEqual({ ok: true, value: { action: "sync", requestKey: "legal-sync:1234" } });
    expect(parseLegalActionInput({ action: "scrape_cabinet", requestKey: "legal-sync:1234" }))
      .toEqual({ ok: false, error: "bad_action" });
  });

  it("fingerprints a token without including it in the persisted operation fingerprint", () => {
    const one = legalOperationFingerprint({ operation: "connect", providerId: "vendor", token: "secret-one" });
    const two = legalOperationFingerprint({ operation: "connect", providerId: "vendor", token: "secret-two" });
    expect(one).toMatch(/^[a-f0-9]{64}$/);
    expect(one).not.toContain("secret-one");
    expect(one).not.toBe(two);
  });
});

describe("legal connection serializer", () => {
  it("exposes status and dates but no encrypted token or sync cursor", () => {
    const serialized = serializeLegalConnection({
      id: "8",
      provider_id: "vendor",
      provider_label: "Vendor",
      integration_kind: "official_api",
      status: "connected",
      subscription_status: "active",
      external_account_label: "Редакция",
      token_expires_at: "2026-12-01T00:00:00Z",
      last_sync_at: null,
      last_health_at: null,
      last_error_code: null,
      last_error_message: null,
      created_at: "2026-08-05T00:00:00Z",
      updated_at: "2026-08-05T00:00:00Z",
    });
    expect(serialized).toMatchObject({ id: 8, status: "connected", subscriptionStatus: "active" });
    expect(serialized).not.toHaveProperty("tokenEnvelope");
    expect(serialized).not.toHaveProperty("syncCursor");
  });
});
