import {
  hasAutomaticQualityApproval,
  hasVerifiedQualityMetadata,
} from "./post-quality.mjs";
import { QUALITY_FAILURE_GUIDE } from "./autopilot-quality-report.mjs";

const SERVER_ATTESTATION = Symbol("aurora.autopilot.server_attestation");

/**
 * Reason codes that mean the semantic checker reached no verdict, rather than a negative one.
 * Only an unsettled claim may leave a post approvable by a person; a claim the checker
 * actually found fault with is the caller's to fix.
 */
const SEMANTIC_UNSETTLED_REASON_CODES = new Set([
  "semantic_provider_unavailable",
  "semantic_provider_failed",
  "adapter_unknown",
]);

function hardQualityViolations(quality) {
  return (Array.isArray(quality?.violations) ? quality.violations : [])
    .filter((violation) =>
      QUALITY_FAILURE_GUIDE[violation?.code]?.publicationDisposition === "blocked",
    );
}

/**
 * Editorial rules passed, but claim-level auto-check did not. A person may approve
 * this draft; full-auto and unattended publication may not.
 */
export function isAutopilotHumanReviewItem(item) {
  if (![
    "semantic_only_review",
    "editorial_review",
  ].includes(item?.reviewState) || item?.reviewRequired !== true) return false;
  if (item?.humanAttestation != null) return false;
  if (item?.aiReady === false) return false;
  if (!hasVerifiedQualityMetadata(item?.quality)) return false;
  if (item.quality.metadata?.provenance?.humanAttestation != null) return false;
  if (Array.isArray(item.invented) && item.invented.length > 0) return false;
  if (hasAutomaticQualityApproval(item.quality)) return false;
  if (item.quality.passed !== true) return false;
  if (Array.isArray(item.quality.blockers) && item.quality.blockers.length > 0) return false;
  if (hardQualityViolations(item.quality).length > 0) return false;
  if (item.reviewState === "editorial_review") {
    return Boolean(
      item.quality.publicationDisposition === "confirmation_required" &&
      item.quality.semantic?.status === "passed" &&
      item.quality.semantic?.passed === true,
    );
  }
  const semantic = item.quality.semantic;
  const semanticOnlyViolation = (Array.isArray(item.quality.violations)
    ? item.quality.violations
    : []).some((violation) => violation?.code === "semantic_review_required");
  const claimVerdicts = Array.isArray(semantic?.claimVerdicts) ? semantic.claimVerdicts : [];
  // Every claim is either a non-finding, or one the checker openly failed to settle, and at
  // least one is unsettled. Nothing here was contradicted, so a reader is the resolution.
  //
  // This previously demanded that *every* verdict be `unknown` under one of two provider
  // outage codes. No real response has that shape: the adapter answers, correctly labels
  // headings and calls to action `non_factual`, and returns `adapter_unknown` for what it
  // cannot settle. A post with nothing at all against it therefore matched neither branch,
  // was demoted to `failed`, and was dropped from the week. In the first production build
  // that got this far, six of ten finished posts were lost that way — three of them holding
  // `adapter_unknown` as their only unsettled verdict — and the plan landed `partial` at
  // four posts with an empty cause list, which is what "it does not collect a week" was.
  //
  // `unverified_*` and `unsupported_*` stay out: those are findings about the claim, not the
  // checker giving up, and they are the caller's to fix rather than a reader's to wave
  // through. `semantic_verdict_missing` also stays out: a claim the adapter silently skipped
  // is an integrity gap in its answer, not a considered "I cannot tell".
  const semanticCouldNotSettle = claimVerdicts.length > 0
    && claimVerdicts.every((verdict) => (
      verdict?.verdict === "supported"
      || verdict?.verdict === "non_factual"
      || (verdict?.verdict === "unknown"
        && SEMANTIC_UNSETTLED_REASON_CODES.has(String(verdict?.reasonCode)))
    ))
    && claimVerdicts.some((verdict) => verdict?.verdict === "unknown");
  return Boolean(
    semanticOnlyViolation &&
      semantic && typeof semantic === "object" &&
      semantic.version === 1 &&
      semantic.status === "not_checked" &&
      semantic.passed === false &&
      semantic.requiresReview === true &&
      semantic.provenance?.validatorVersion === "semantic-publication-v1" &&
      semantic.provenance?.terminalVerdict === "not_checked" &&
      typeof semantic.provenance?.provider === "string" &&
      semantic.provenance.provider.length > 0 &&
      semanticCouldNotSettle
  );
}

/**
 * Reader-ready is the public product boundary: every automatic editorial and semantic gate
 * has passed. A draft that still needs a person is useful diagnostic material, but it is not
 * one of the promised ready publications and stays inside the generator.
 */
export function isAutopilotReaderReadyItem(item) {
  if (item?.aiReady !== true || !String(item?.draft || "").trim()) return false;
  if (!hasVerifiedQualityMetadata(item?.quality)) return false;
  if (Array.isArray(item?.invented) && item.invented.length > 0) return false;
  return Boolean(
      item?.qualityBlocked !== true &&
      item?.reviewRequired !== true &&
      item?.quality?.passed === true &&
      !["confirmation_required", "blocked"].includes(item.quality.publicationDisposition) &&
      Number(item.quality.score) >= Number(item.quality.threshold) &&
      hardQualityViolations(item.quality).length === 0,
  );
}

export function attestAutopilotItemForHumanApproval(item, { userId, attestedAt } = {}) {
  if (!isAutopilotHumanReviewItem(item)) return item;
  const id = Number(userId);
  const timestamp = new Date(attestedAt ?? Date.now());
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(timestamp.getTime())) return item;
  const humanAttestation = Object.freeze({
    kind: "human_review",
    reviewState: item.reviewState,
    userId: id,
    attestedAt: timestamp.toISOString(),
    qualityCheckedAt: item.quality.metadata.checkedAt,
  });
  return {
    ...item,
    humanAttestation,
    qualityOrigin: "human_attested",
    [SERVER_ATTESTATION]: humanAttestation,
  };
}

export function hasServerAutopilotHumanAttestation(item) {
  const attestation = item?.humanAttestation;
  return Boolean(
    isAutopilotHumanReviewItem({ ...item, humanAttestation: undefined }) &&
      attestation &&
      item[SERVER_ATTESTATION] === attestation &&
      attestation.kind === "human_review" &&
      attestation.reviewState === item.reviewState &&
      Number.isSafeInteger(attestation.userId) &&
      attestation.userId > 0 &&
      attestation.qualityCheckedAt === item.quality.metadata.checkedAt,
  );
}

export { hardQualityViolations };
