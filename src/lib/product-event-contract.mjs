const EVENT_GROUPS = Object.freeze([
  Object.freeze({
    names: Object.freeze([
      "onboarding_step_viewed",
      "onboarding_step_completed",
      "onboarding_step_failed",
      "onboarding_step_skipped",
    ]),
    properties: Object.freeze(["step_id", "project_id", "role", "session_id", "error_code"]),
  }),
  Object.freeze({
    names: Object.freeze(["first_draft_created", "first_draft_saved"]),
    properties: Object.freeze(["draft_id", "source", "latency_bucket", "save_version"]),
  }),
  Object.freeze({
    names: Object.freeze([
      "publish_intent",
      "publish_queued",
      "publish_succeeded",
      "publish_failed",
      "publish_retried",
    ]),
    properties: Object.freeze([
      "publication_id",
      "provider",
      "idempotency_key_hash",
      "error_code",
    ]),
  }),
  Object.freeze({
    names: Object.freeze([
      "integration_connect_started",
      "integration_connect_succeeded",
      "integration_connect_failed",
      "integration_connect_revoked",
    ]),
    properties: Object.freeze(["provider", "method", "error_code"]),
  }),
  Object.freeze({
    names: Object.freeze(["permission_denied", "session_expired", "conflict_detected"]),
    properties: Object.freeze(["route", "role", "resource_type", "recovery_action"]),
  }),
  Object.freeze({
    names: Object.freeze(["ui_error_shown", "retry_clicked", "recovery_succeeded"]),
    properties: Object.freeze(["error_contract_id", "route", "attempt"]),
  }),
]);

export const PRODUCT_EVENT_PROPERTIES = Object.freeze(Object.fromEntries(
  EVENT_GROUPS.flatMap((group) => group.names.map((name) => [name, group.properties])),
));

const SAFE_ERROR_CODE = /^[a-z0-9_]{1,100}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const SAFE_ROUTE = /^\/[A-Za-z0-9_./-]*$/u;
const EMAIL_LIKE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[A-Za-z]{2,}/u;
const ABSOLUTE_URL = /(?:https?|tg):\/\//iu;
const ONE_TIME_TOKEN = /^[A-Za-z0-9_-]{43}$/u;

function plainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeScalar(value) {
  return value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function propertyError(property, value) {
  if (!safeScalar(value)) return "product_event_property_not_scalar";
  if (value === null || typeof value !== "string") return null;
  if (property === "error_code" && !SAFE_ERROR_CODE.test(value)) {
    return "product_event_error_code_invalid";
  }
  if (property === "idempotency_key_hash" && !SHA256_HEX.test(value)) {
    return "product_event_idempotency_hash_invalid";
  }
  if (property === "route" && !SAFE_ROUTE.test(value)) {
    return "product_event_route_invalid";
  }
  if (EMAIL_LIKE.test(value) || ABSOLUTE_URL.test(value) || ONE_TIME_TOKEN.test(value)) {
    return "product_event_sensitive_value";
  }
  return null;
}

export function validateProductEventDraft(name, properties = {}) {
  if (typeof name !== "string" || !Object.hasOwn(PRODUCT_EVENT_PROPERTIES, name)) {
    return Object.freeze({ ok: false, error: "product_event_unknown" });
  }
  const allowed = PRODUCT_EVENT_PROPERTIES[name];
  if (!plainRecord(properties)) {
    return Object.freeze({ ok: false, error: "product_event_properties_invalid" });
  }
  const allowedProperties = new Set(allowed);
  const normalized = {};
  for (const [property, value] of Object.entries(properties)) {
    if (!allowedProperties.has(property)) {
      return Object.freeze({
        ok: false,
        error: "product_event_property_not_allowed",
        property,
      });
    }
    const error = propertyError(property, value);
    if (error) return Object.freeze({ ok: false, error, property });
    normalized[property] = value;
  }
  return Object.freeze({
    ok: true,
    event: Object.freeze({ name, properties: Object.freeze(normalized) }),
  });
}

// Operational-center taxonomy. The legacy name/properties validator above remains
// available for the stabilization callers that already depend on it. New telemetry
// uses this section/feature/action envelope and never accepts tenant identity from a
// browser payload.
export const AURORA_EVENT_STAGES = Object.freeze([
  "started",
  "accepted",
  "queued",
  "processing",
  "completed",
  "failed",
  "retried",
  "cancelled",
]);

export const AURORA_EVENT_OUTCOMES = Object.freeze([
  "pending",
  "success",
  "failure",
  "cancelled",
]);

export const AURORA_PRODUCT_FEATURES = Object.freeze({
  today: Object.freeze({
    work_item: Object.freeze(["loaded", "task_selected", "task_completed", "task_deferred"]),
  }),
  calendar: Object.freeze({
    publication: Object.freeze(["loaded", "created", "edited", "rescheduled", "scheduled"]),
  }),
  studio: Object.freeze({
    generation: Object.freeze(["loaded", "requested", "result_received", "saved", "used"]),
  }),
  autopilot: Object.freeze({
    plan: Object.freeze(["loaded", "planned", "generated", "approved", "scheduled"]),
  }),
  composer: Object.freeze({
    draft: Object.freeze(["loaded", "edited", "saved", "published"]),
  }),
  library: Object.freeze({
    idea: Object.freeze(["loaded", "searched", "opened", "saved", "used"]),
  }),
  rss: Object.freeze({
    legal_opportunity: Object.freeze(["loaded", "refreshed", "opened", "saved", "hidden", "used"]),
  }),
  knowledge: Object.freeze({
    source: Object.freeze(["loaded", "added", "processed", "searched", "used"]),
  }),
  recon: Object.freeze({
    competitor: Object.freeze(["loaded", "added", "synchronized", "signal_opened", "used"]),
  }),
  opportunities: Object.freeze({
    map: Object.freeze(["loaded", "built", "recommendation_opened", "applied"]),
  }),
  radar: Object.freeze({
    search: Object.freeze(["loaded", "searched", "results_received", "saved", "used"]),
  }),
  siteAnalysis: Object.freeze({
    analysis: Object.freeze(["loaded", "started", "crawled", "analyzed", "report_opened", "acted"]),
  }),
  sites: Object.freeze({
    site: Object.freeze(["loaded", "connected", "verified", "article_approved", "published", "report_opened"]),
  }),
  growth: Object.freeze({
    recommendation: Object.freeze(["loaded", "opened", "accepted", "completed", "result_confirmed"]),
  }),
  analytics: Object.freeze({
    report: Object.freeze(["loaded", "filtered", "analyzed", "acted"]),
  }),
  settings: Object.freeze({
    configuration: Object.freeze(["loaded", "changed", "verified", "connected", "saved"]),
  }),
});

export const AURORA_SECTION_IDS = Object.freeze(Object.keys(AURORA_PRODUCT_FEATURES));

export const AURORA_SAFE_CONTEXT_PROPERTIES = Object.freeze({
  device: Object.freeze(["desktop", "mobile", "tablet", "unknown"]),
  source: Object.freeze(["ui", "api", "worker", "bot", "system"]),
  operationKind: null,
  appVersion: null,
  queue: Object.freeze([
    "publish",
    "stats",
    "media-generation",
    "autopilot-plans",
    "site-analysis",
    "project-export",
    "publication-extra",
    "monthly-campaign-regeneration",
    "legal-visual-render",
    "publication-review-reminder",
    "cron",
  ]),
  httpStatus: null,
  attempt: null,
  resultKind: null,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const SAFE_CONTEXT_SLUG = /^[a-z0-9][a-z0-9_.:-]{0,63}$/u;
const BEARER_LIKE = /\bbearer\s+[A-Za-z0-9._~+/-]+=*/iu;
const COOKIE_LIKE = /(?:^|[;\s])(?:sid|session|cookie|authorization)=/iu;
const SENSITIVE_KEY = /(?:token|password|secret|cookie|authorization|email|phone|content|prompt|response|text|url)/iu;
const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;

function auroraEventFailure(error, field) {
  return Object.freeze({ ok: false, error, ...(field ? { field } : {}) });
}

function safeTelemetryString(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && !EMAIL_LIKE.test(value)
    && !ABSOLUTE_URL.test(value)
    && !ONE_TIME_TOKEN.test(value)
    && !BEARER_LIKE.test(value)
    && !COOKIE_LIKE.test(value);
}

function validateSafeContext(value) {
  if (value === undefined) return { ok: true, value: Object.freeze({}) };
  if (!plainRecord(value)) return auroraEventFailure("aurora_event_safe_context_invalid", "safeContext");
  const entries = Object.entries(value);
  if (entries.length > 8) return auroraEventFailure("aurora_event_safe_context_too_large", "safeContext");
  const normalized = {};
  for (const [key, item] of entries) {
    if (SENSITIVE_KEY.test(key) || !Object.hasOwn(AURORA_SAFE_CONTEXT_PROPERTIES, key)) {
      return auroraEventFailure("aurora_event_context_property_not_allowed", `safeContext.${key}`);
    }
    if (key === "httpStatus") {
      if (!Number.isSafeInteger(item) || item < 100 || item > 599) {
        return auroraEventFailure("aurora_event_context_value_invalid", `safeContext.${key}`);
      }
    } else if (key === "attempt") {
      if (!Number.isSafeInteger(item) || item < 0 || item > 100) {
        return auroraEventFailure("aurora_event_context_value_invalid", `safeContext.${key}`);
      }
    } else {
      if (!safeTelemetryString(item)) {
        return auroraEventFailure("aurora_event_sensitive_value", `safeContext.${key}`);
      }
      const allowed = AURORA_SAFE_CONTEXT_PROPERTIES[key];
      if (Array.isArray(allowed) ? !allowed.includes(item) : !SAFE_CONTEXT_SLUG.test(item)) {
        return auroraEventFailure("aurora_event_context_value_invalid", `safeContext.${key}`);
      }
    }
    normalized[key] = item;
  }
  return { ok: true, value: Object.freeze(normalized) };
}

export function validateAuroraProductEventDraft(value, options = {}) {
  if (!plainRecord(value)) return auroraEventFailure("aurora_event_invalid");
  const allowedFields = new Set([
    "eventId",
    "sectionId",
    "featureId",
    "action",
    "stage",
    "outcome",
    "durationMs",
    "errorCode",
    "requestId",
    "operationId",
    "sessionId",
    "occurredAt",
    "safeContext",
  ]);
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) return auroraEventFailure("aurora_event_field_not_allowed", field);
  }

  if (typeof value.eventId !== "string" || !UUID.test(value.eventId)) {
    return auroraEventFailure("aurora_event_id_invalid", "eventId");
  }
  const section = typeof value.sectionId === "string" ? AURORA_PRODUCT_FEATURES[value.sectionId] : null;
  if (!section) return auroraEventFailure("aurora_event_section_invalid", "sectionId");
  const actions = typeof value.featureId === "string" ? section[value.featureId] : null;
  if (!actions) return auroraEventFailure("aurora_event_feature_invalid", "featureId");
  if (typeof value.action !== "string" || !actions.includes(value.action)) {
    return auroraEventFailure("aurora_event_action_invalid", "action");
  }
  if (!AURORA_EVENT_STAGES.includes(value.stage)) {
    return auroraEventFailure("aurora_event_stage_invalid", "stage");
  }
  if (!AURORA_EVENT_OUTCOMES.includes(value.outcome)) {
    return auroraEventFailure("aurora_event_outcome_invalid", "outcome");
  }
  if (value.stage === "failed" && value.outcome !== "failure") {
    return auroraEventFailure("aurora_event_outcome_conflict", "outcome");
  }
  if (value.stage === "cancelled" && value.outcome !== "cancelled") {
    return auroraEventFailure("aurora_event_outcome_conflict", "outcome");
  }
  if (value.outcome === "success" && !["accepted", "completed"].includes(value.stage)) {
    return auroraEventFailure("aurora_event_outcome_conflict", "outcome");
  }

  const durationMs = value.durationMs == null ? null : Number(value.durationMs);
  if (durationMs !== null && (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 3_600_000)) {
    return auroraEventFailure("aurora_event_duration_invalid", "durationMs");
  }
  const errorCode = value.errorCode == null ? null : value.errorCode;
  if (errorCode !== null && (typeof errorCode !== "string" || !SAFE_ERROR_CODE.test(errorCode))) {
    return auroraEventFailure("aurora_event_error_code_invalid", "errorCode");
  }
  if ((value.stage === "failed" || value.outcome === "failure") && errorCode === null) {
    return auroraEventFailure("aurora_event_error_code_required", "errorCode");
  }

  for (const field of ["requestId", "operationId"]) {
    const item = value[field];
    if (item != null && (typeof item !== "string" || !SAFE_CORRELATION_ID.test(item) || !safeTelemetryString(item))) {
      return auroraEventFailure("aurora_event_correlation_invalid", field);
    }
  }
  if (value.sessionId != null && (typeof value.sessionId !== "string" || !UUID.test(value.sessionId))) {
    return auroraEventFailure("aurora_event_session_invalid", "sessionId");
  }
  if (typeof value.occurredAt !== "string") {
    return auroraEventFailure("aurora_event_time_invalid", "occurredAt");
  }
  const occurredAtMs = Date.parse(value.occurredAt);
  const nowMs = Number(options.nowMs ?? Date.now());
  if (!Number.isFinite(occurredAtMs)
      || new Date(occurredAtMs).toISOString() !== value.occurredAt
      || occurredAtMs < nowMs - MAX_EVENT_AGE_MS
      || occurredAtMs > nowMs + MAX_FUTURE_SKEW_MS) {
    return auroraEventFailure("aurora_event_time_invalid", "occurredAt");
  }
  const context = validateSafeContext(value.safeContext);
  if (!context.ok) return context;

  return Object.freeze({
    ok: true,
    event: Object.freeze({
      eventId: value.eventId.toLowerCase(),
      sectionId: value.sectionId,
      featureId: value.featureId,
      action: value.action,
      stage: value.stage,
      outcome: value.outcome,
      durationMs,
      errorCode,
      requestId: value.requestId ?? null,
      operationId: value.operationId ?? null,
      sessionId: value.sessionId?.toLowerCase() ?? null,
      occurredAt: value.occurredAt,
      safeContext: context.value,
      important: value.stage === "failed" || value.outcome === "failure" || errorCode !== null,
    }),
  });
}
