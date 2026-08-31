import { describe, expect, it } from "vitest";

import {
  AURORA_PRODUCT_FEATURES,
  PRODUCT_EVENT_PROPERTIES,
  validateAuroraProductEventDraft,
  validateProductEventDraft,
} from "./product-event-contract.mjs";

describe("minimum product event taxonomy", () => {
  it("matches the approved-plan event names and property allowlists exactly", () => {
    expect(PRODUCT_EVENT_PROPERTIES).toEqual({
      onboarding_step_viewed: ["step_id", "project_id", "role", "session_id", "error_code"],
      onboarding_step_completed: ["step_id", "project_id", "role", "session_id", "error_code"],
      onboarding_step_failed: ["step_id", "project_id", "role", "session_id", "error_code"],
      onboarding_step_skipped: ["step_id", "project_id", "role", "session_id", "error_code"],
      first_draft_created: ["draft_id", "source", "latency_bucket", "save_version"],
      first_draft_saved: ["draft_id", "source", "latency_bucket", "save_version"],
      publish_intent: ["publication_id", "provider", "idempotency_key_hash", "error_code"],
      publish_queued: ["publication_id", "provider", "idempotency_key_hash", "error_code"],
      publish_succeeded: ["publication_id", "provider", "idempotency_key_hash", "error_code"],
      publish_failed: ["publication_id", "provider", "idempotency_key_hash", "error_code"],
      publish_retried: ["publication_id", "provider", "idempotency_key_hash", "error_code"],
      integration_connect_started: ["provider", "method", "error_code"],
      integration_connect_succeeded: ["provider", "method", "error_code"],
      integration_connect_failed: ["provider", "method", "error_code"],
      integration_connect_revoked: ["provider", "method", "error_code"],
      permission_denied: ["route", "role", "resource_type", "recovery_action"],
      session_expired: ["route", "role", "resource_type", "recovery_action"],
      conflict_detected: ["route", "role", "resource_type", "recovery_action"],
      ui_error_shown: ["error_contract_id", "route", "attempt"],
      retry_clicked: ["error_contract_id", "route", "attempt"],
      recovery_succeeded: ["error_contract_id", "route", "attempt"],
    });
  });

  it("accepts only allowlisted scalar properties", () => {
    expect(validateProductEventDraft("publish_failed", {
      publication_id: 42,
      provider: "telegram",
      idempotency_key_hash: "a".repeat(64),
      error_code: "provider_timeout",
    })).toEqual({
      ok: true,
      event: {
        name: "publish_failed",
        properties: {
          publication_id: 42,
          provider: "telegram",
          idempotency_key_hash: "a".repeat(64),
          error_code: "provider_timeout",
        },
      },
    });
    expect(validateProductEventDraft("publish_failed", { provider: { name: "telegram" } }))
      .toEqual({ ok: false, error: "product_event_property_not_scalar", property: "provider" });
  });

  it.each(["token", "password", "phone", "email", "content", "url", "fragment"])(
    "rejects the non-allowlisted sensitive property %s",
    (property) => {
      expect(validateProductEventDraft("integration_connect_started", { [property]: "secret" }))
        .toEqual({ ok: false, error: "product_event_property_not_allowed", property });
    },
  );

  it.each([
    ["provider", "owner@example.test", "product_event_sensitive_value"],
    ["source", "https://example.test/private#token", "product_event_sensitive_value"],
    ["source", "a".repeat(43), "product_event_sensitive_value"],
    ["error_code", "Provider timeout", "product_event_error_code_invalid"],
    ["idempotency_key_hash", "raw-idempotency-key", "product_event_idempotency_hash_invalid"],
    ["route", "/bot/connect#token=secret", "product_event_route_invalid"],
  ])("rejects an unsafe %s value", (property, value, error) => {
    const event = property === "source"
      ? "first_draft_created"
      : property === "route"
        ? "permission_denied"
        : "publish_failed";
    expect(validateProductEventDraft(event, { [property]: value }))
      .toEqual({ ok: false, error, property });
  });

  it("fails closed for unknown events and invalid property containers", () => {
    expect(validateProductEventDraft("custom_event", {}))
      .toEqual({ ok: false, error: "product_event_unknown" });
    expect(validateProductEventDraft("__proto__", {}))
      .toEqual({ ok: false, error: "product_event_unknown" });
    expect(validateProductEventDraft("retry_clicked", []))
      .toEqual({ ok: false, error: "product_event_properties_invalid" });
  });
});

describe("Aurora operational product event envelope", () => {
  const occurredAt = "2026-08-30T10:00:00.000Z";
  const nowMs = Date.parse("2026-08-30T10:01:00.000Z");
  const event = {
    eventId: "11111111-1111-4111-8111-111111111111",
    sectionId: "studio",
    featureId: "generation",
    action: "result_received",
    stage: "completed",
    outcome: "success",
    durationMs: 1840,
    requestId: "request:studio:41",
    operationId: "generation:41",
    sessionId: "22222222-2222-4222-8222-222222222222",
    occurredAt,
    safeContext: { device: "desktop", source: "ui", resultKind: "draft" },
  };

  it("contains the fifteen APP_NAV_GROUPS sections and their strict feature actions", () => {
    expect(Object.keys(AURORA_PRODUCT_FEATURES)).toEqual([
      "today", "calendar", "studio", "autopilot", "composer", "library", "rss", "knowledge",
      "recon", "opportunities", "radar", "siteAnalysis", "growth", "analytics", "settings",
    ]);
    expect(AURORA_PRODUCT_FEATURES.siteAnalysis.analysis).toContain("report_opened");
  });

  it("normalizes a safe allowlisted event without tenant identity", () => {
    expect(validateAuroraProductEventDraft(event, { nowMs })).toEqual({
      ok: true,
      event: {
        ...event,
        errorCode: null,
        important: false,
      },
    });
  });

  it.each(["userId", "projectId", "release", "metadata", "eventName"])(
    "rejects the client-owned or arbitrary field %s",
    (field) => {
      expect(validateAuroraProductEventDraft({ ...event, [field]: 7 }, { nowMs }))
        .toEqual({ ok: false, error: "aurora_event_field_not_allowed", field });
    },
  );

  it("rejects unknown sections, features and actions", () => {
    expect(validateAuroraProductEventDraft({ ...event, sectionId: "private" }, { nowMs }))
      .toEqual({ ok: false, error: "aurora_event_section_invalid", field: "sectionId" });
    expect(validateAuroraProductEventDraft({ ...event, featureId: "prompt" }, { nowMs }))
      .toEqual({ ok: false, error: "aurora_event_feature_invalid", field: "featureId" });
    expect(validateAuroraProductEventDraft({ ...event, action: "custom" }, { nowMs }))
      .toEqual({ ok: false, error: "aurora_event_action_invalid", field: "action" });
  });

  it.each([
    ["email", "owner@example.test"],
    ["content", "private post"],
    ["prompt", "write private content"],
    ["url", "https://private.example/path"],
    ["authorization", "Bearer private"],
    ["token", "secret"],
  ])("rejects PII/content context key %s", (key, value) => {
    expect(validateAuroraProductEventDraft({ ...event, safeContext: { [key]: value } }, { nowMs }))
      .toEqual({
        ok: false,
        error: "aurora_event_context_property_not_allowed",
        field: `safeContext.${key}`,
      });
  });

  it("requires a safe code for failures and marks them important", () => {
    expect(validateAuroraProductEventDraft({
      ...event,
      stage: "failed",
      outcome: "failure",
    }, { nowMs })).toEqual({ ok: false, error: "aurora_event_error_code_required", field: "errorCode" });

    expect(validateAuroraProductEventDraft({
      ...event,
      stage: "failed",
      outcome: "failure",
      errorCode: "provider_timeout",
    }, { nowMs })).toMatchObject({ ok: true, event: { important: true, errorCode: "provider_timeout" } });
  });

  it("rejects stale timestamps, outcome conflicts and unsafe correlations", () => {
    expect(validateAuroraProductEventDraft({ ...event, occurredAt: "2026-08-28T10:00:00.000Z" }, { nowMs }))
      .toEqual({ ok: false, error: "aurora_event_time_invalid", field: "occurredAt" });
    expect(validateAuroraProductEventDraft({ ...event, stage: "failed" }, { nowMs }))
      .toEqual({ ok: false, error: "aurora_event_outcome_conflict", field: "outcome" });
    expect(validateAuroraProductEventDraft({ ...event, requestId: "owner@example.test" }, { nowMs }))
      .toEqual({ ok: false, error: "aurora_event_correlation_invalid", field: "requestId" });
  });
});
