// Explicit accounting policy for every AI provider surface owned by worker.mjs.
//
// `user` means that the provider output becomes a user-visible artifact (or a post) and
// therefore must run under the shared ai_usage reservation. One logical operation may
// make several provider calls (Autopilot drafting + editorial retries), but they all use
// the same reservation and become one visible result.
//
// `system` is deliberately non-billable: these calls only classify/index/maintain internal
// context and never create a user-requested draft. Keeping this list explicit prevents a
// background classifier from silently consuming the counter shown in the product UI.

export const WORKER_AI_SURFACES = Object.freeze({
  "knowledge-embedding": Object.freeze({ billing: "system", purpose: "retrieval_index" }),
  "competitor-niche-classifier": Object.freeze({ billing: "system", purpose: "internal_classification" }),
  "competitor-reader-classifier": Object.freeze({ billing: "system", purpose: "internal_classification" }),
  "profile-refresh": Object.freeze({ billing: "system", purpose: "background_context_maintenance" }),
  "radar-query-expansion": Object.freeze({ billing: "system", purpose: "search_query_expansion" }),

  "radar-osint-profile": Object.freeze({ billing: "user", purpose: "visible_osint_profile" }),
  "competitor-idea": Object.freeze({ billing: "user", purpose: "visible_content_idea" }),
  "rss-summary": Object.freeze({ billing: "user", purpose: "scheduled_user_post" }),
  "autopilot-plan": Object.freeze({ billing: "user", purpose: "visible_content_plan" }),
  "bot-idea": Object.freeze({ billing: "user", purpose: "visible_draft" }),
  "bot-intake": Object.freeze({ billing: "user", purpose: "visible_draft" }),
  "bot-client-reply": Object.freeze({ billing: "user", purpose: "visible_client_reply" }),
  "media-generation": Object.freeze({ billing: "user", purpose: "visible_media_asset" }),
  "site-analysis-interview": Object.freeze({ billing: "user", purpose: "visible_osint_report" }),
  "site-article": Object.freeze({ billing: "user", purpose: "visible_site_article" }),
  "site-visibility-probe": Object.freeze({ billing: "user", purpose: "visible_visibility_report" }),
});

function positiveReservationId(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

/**
 * Fail closed at the provider boundary: a billable surface cannot call a model without a
 * live reservation id, and an internal surface cannot accidentally be charged to a user.
 */
export function assertWorkerAiCallPolicy(surfaceValue, reservationId = null) {
  const surface = String(surfaceValue ?? "").trim();
  const policy = WORKER_AI_SURFACES[surface];
  if (!policy) throw new TypeError(`worker AI: unknown surface ${surface || "(empty)"}`);
  const normalizedReservationId = positiveReservationId(reservationId);
  if (policy.billing === "user" && normalizedReservationId === null) {
    throw new Error(`worker AI: ${surface} requires an ai_usage reservation`);
  }
  if (policy.billing === "system" && reservationId != null) {
    throw new Error(`worker AI: ${surface} is non-billable by policy`);
  }
  return policy;
}
