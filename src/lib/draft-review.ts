import type {
  DraftAiValidation,
  DraftHumanReview,
  ServerDraft,
} from "./draft-types";
import type { Post } from "./types";

export const DRAFT_REVIEW_POLICY_VERSION = 1 as const;

type ReviewInput = Pick<
  ServerDraft,
  "origin" | "purpose" | "generation_result_id" | "generation_binding_valid"
  | "version" | "review_policy_version" | "ai_validation" | "human_review"
>;

export type DraftReviewDecision = "allowed" | "review_required" | "blocked";
export type DraftReviewBlockedReason =
  | "legacy_generation_missing"
  | "validation_blocked"
  | "source_context_not_publishable"
  | "malformed_validation"
  | "unknown_block";

export type DraftReviewAssessment = {
  decision: DraftReviewDecision;
  blockedReason: DraftReviewBlockedReason | null;
};

export function isDraftRecoveryAllowedReason(
  reason: DraftReviewBlockedReason | null | undefined,
  options: { personalResponsibilityTakeover?: boolean } = {},
): boolean {
  if (reason == null) return false;
  if (reason === "validation_blocked") {
    return options.personalResponsibilityTakeover === true;
  }
  return true;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function boundedStrings(value: unknown, maxItems: number, maxLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const strings = value.filter(
    (item): item is string =>
      typeof item === "string" && item.length > 0 && item.length <= maxLength,
  );
  return strings.length === value.length ? [...new Set(strings)] : null;
}

/** Strict JSON boundary for validation events returned by the server AI pipeline. */
export function normalizeDraftAiValidation(value: unknown): DraftAiValidation | null {
  if (!record(value) || value.version !== 1) return null;
  const status = value.status;
  if (status !== "passed" && status !== "blocked" && status !== "not_checked") return null;
  if (typeof value.requiresReview !== "boolean" || !record(value.provenance)) return null;
  const provenance = value.provenance;
  const coverage = provenance.coverage;
  const semanticEntailment = provenance.semanticEntailment;
  if (
    provenance.validatorVersion !== "fact-ledger-v1" ||
    typeof provenance.ledgerHash !== "string" ||
    !/^fl1-[0-9a-f]{8}$/u.test(provenance.ledgerHash) ||
    !canonicalIso(provenance.checkedAt) ||
    (coverage !== "deterministic" && coverage !== "deterministic+semantic") ||
    semanticEntailment !== "not_run" &&
    semanticEntailment !== "not_checked" &&
    semanticEntailment !== "passed" &&
    semanticEntailment !== "blocked"
  ) {
    return null;
  }
  const rulesRun = boundedStrings(provenance.rulesRun, 100, 100);
  const sourceIds = boundedStrings(provenance.sourceIds, 200, 200);
  const blockerCodes = boundedStrings(value.blockerCodes, 100, 100);
  if (!rulesRun || !sourceIds || !blockerCodes) return null;
  let topicAlignment: DraftAiValidation["topicAlignment"];
  if (value.topicAlignment != null) {
    if (
      !record(value.topicAlignment)
      || (value.topicAlignment.status !== "passed" && value.topicAlignment.status !== "failed")
      || !Number.isFinite(value.topicAlignment.score)
      || Number(value.topicAlignment.score) < 0
      || Number(value.topicAlignment.score) > 1
      || typeof value.topicAlignment.topic !== "string"
      || !value.topicAlignment.topic.trim()
      || value.topicAlignment.topic.length > 500
    ) return null;
    topicAlignment = {
      status: value.topicAlignment.status,
      score: Number(value.topicAlignment.score),
      topic: value.topicAlignment.topic,
    };
  }
  if (provenance.semanticAdapter != null) {
    if (
      typeof provenance.semanticAdapter !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(provenance.semanticAdapter)
    ) {
      return null;
    }
  }

  if (
    (status === "passed" &&
      (value.requiresReview ||
        blockerCodes.length > 0 ||
        coverage !== "deterministic+semantic" ||
        semanticEntailment !== "passed")) ||
    // A blocked generation remains useful as a durable editing draft, but can never be
    // attested into publishability. The text must be changed and validated as a new result.
    (status === "blocked" && blockerCodes.length === 0) ||
    (status === "not_checked" &&
      (!value.requiresReview || semanticEntailment !== "not_checked"))
  ) {
    return null;
  }

  return {
    version: 1,
    status,
    requiresReview: value.requiresReview,
    blockerCodes,
    ...(topicAlignment ? { topicAlignment } : {}),
    provenance: {
      validatorVersion: "fact-ledger-v1",
      ledgerHash: provenance.ledgerHash,
      checkedAt: provenance.checkedAt,
      coverage,
      semanticEntailment,
      ...(provenance.semanticAdapter == null
        ? {}
        : { semanticAdapter: provenance.semanticAdapter }),
      rulesRun,
      sourceIds,
    },
  };
}

export function validCurrentHumanReview(
  value: DraftHumanReview | null | undefined,
  draftVersion: number,
): boolean {
  return Boolean(
    value?.policy_version === DRAFT_REVIEW_POLICY_VERSION &&
      Number.isSafeInteger(value?.draft_version) &&
      value?.draft_version === draftVersion &&
      canonicalIso(value?.attested_at),
  );
}

/**
 * One strict server/client policy for both the decision and its user-visible reason.
 * Components must never infer a reason from individual nullable provenance fields.
 */
export function draftReviewAssessment(input: {
  origin: Post["origin"];
  purpose: ServerDraft["purpose"];
  generation_result_id: number | null;
  generation_binding_valid: boolean;
  version: number;
  review_policy_version: number;
  ai_validation: unknown;
  human_review: DraftHumanReview | null;
}): DraftReviewAssessment {
  if (input.purpose === "source_context") {
    return { decision: "blocked", blockedReason: "source_context_not_publishable" };
  }
  // Manual-origin drafts deliberately bypass AI review gates. A non-publishable manual
  // row still fails closed instead of being silently promoted by the client.
  if (input.origin !== "ai") {
    return {
      decision: input.purpose === "publishable" ? "allowed" : "review_required",
      blockedReason: null,
    };
  }
  // Legacy/client-forged AI rows have no immutable result and can never be attested into
  // publishability. They remain recoverable for inspection, but fail closed forever.
  if (!input.generation_result_id) {
    return { decision: "blocked", blockedReason: "legacy_generation_missing" };
  }
  if (input.review_policy_version !== DRAFT_REVIEW_POLICY_VERSION) {
    return { decision: "review_required", blockedReason: null };
  }

  const validation = normalizeDraftAiValidation(input.ai_validation);
  if (input.ai_validation != null && !validation) {
    return { decision: "blocked", blockedReason: "malformed_validation" };
  }
  if (validation?.status === "blocked") {
    return { decision: "blocked", blockedReason: "validation_blocked" };
  }
  // Only a server-bound result that completed every validation gate is immediately
  // publishable. Human review may attest an unavailable/not-checked validator, but it
  // must never override an explicit blocker.
  if (validation?.status === "passed") {
    return input.generation_binding_valid
      ? { decision: "allowed", blockedReason: null }
      : { decision: "blocked", blockedReason: "unknown_block" };
  }
  return {
    decision: validCurrentHumanReview(input.human_review, input.version)
      ? "allowed"
      : "review_required",
    blockedReason: null,
  };
}

/** Server scheduling policy. */
export function draftReviewDecision(input: Parameters<typeof draftReviewAssessment>[0]): DraftReviewDecision {
  return draftReviewAssessment(input).decision;
}

export function composerAiReviewState(input: ReviewInput | null | undefined):
  | "none"
  | "required"
  | "blocked" {
  if (!input) return "none";
  const decision = draftReviewAssessment(input).decision;
  return decision === "blocked" ? "blocked" : decision === "allowed" ? "none" : "required";
}
