import {
  hasAutomaticQualityApproval,
  hasVerifiedQualityMetadata,
} from "./post-quality.mjs";
import { QUALITY_FAILURE_GUIDE } from "./autopilot-quality-report.mjs";

const SERVER_ATTESTATION = Symbol("aurora.autopilot.server_attestation");

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
  const semanticProviderUnavailable =
    semantic?.provenance?.provider === "unavailable" &&
    Array.isArray(semantic.claimVerdicts) &&
    semantic.claimVerdicts.every((verdict) =>
      verdict?.verdict === "unknown" && verdict?.reasonCode === "semantic_provider_unavailable"
    );
  const semanticProviderFailed =
    semantic?.provenance?.provider === "aurora-semantic-ai-v1" &&
    Array.isArray(semantic.claimVerdicts) &&
    semantic.claimVerdicts.every((verdict) =>
      verdict?.verdict === "unknown" && verdict?.reasonCode === "semantic_provider_failed"
    );
  return Boolean(
    semanticOnlyViolation &&
      semantic && typeof semantic === "object" &&
      semantic.version === 1 &&
      semantic.status === "not_checked" &&
      semantic.passed === false &&
      semantic.requiresReview === true &&
      semantic.provenance?.validatorVersion === "semantic-publication-v1" &&
      semantic.provenance?.terminalVerdict === "not_checked" &&
      Array.isArray(semantic.claimVerdicts) &&
      semantic.claimVerdicts.length > 0 &&
      (semanticProviderUnavailable || semanticProviderFailed)
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
