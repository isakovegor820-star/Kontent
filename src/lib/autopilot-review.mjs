import {
  hasAutomaticQualityApproval,
  hasVerifiedQualityMetadata,
} from "./post-quality.mjs";

const SERVER_ATTESTATION = Symbol("aurora.autopilot.server_attestation");

function hardQualityViolations(quality) {
  return (Array.isArray(quality?.violations) ? quality.violations : [])
    .filter((violation) => violation?.blocker === true && violation.code !== "semantic_review_required");
}

/**
 * Editorial rules passed, but claim-level auto-check did not. A person may approve
 * this draft; full-auto and unattended publication may not.
 */
export function isAutopilotHumanReviewItem(item) {
  if (item?.reviewState !== "semantic_only_review" || item?.reviewRequired !== true) return false;
  if (item?.humanAttestation != null) return false;
  if (item?.aiReady === false) return false;
  if (!hasVerifiedQualityMetadata(item?.quality)) return false;
  if (item.quality.metadata?.provenance?.humanAttestation != null) return false;
  if (Array.isArray(item.invented) && item.invented.length > 0) return false;
  if (hasAutomaticQualityApproval(item.quality)) return false;
  if (item.quality.passed !== true) return false;
  if (Number(item.quality.score) < Number(item.quality.threshold)) return false;
  if (Array.isArray(item.quality.blockers) && item.quality.blockers.length > 0) return false;
  if (hardQualityViolations(item.quality).length > 0) return false;
  const semantic = item.quality.semantic;
  const semanticOnlyViolation = (Array.isArray(item.quality.violations)
    ? item.quality.violations
    : []).some((violation) => violation?.code === "semantic_review_required");
  return Boolean(
    semanticOnlyViolation &&
      semantic && typeof semantic === "object" &&
      semantic.version === 1 &&
      semantic.status === "not_checked" &&
      semantic.passed === false &&
      semantic.requiresReview === true &&
      semantic.provenance?.validatorVersion === "semantic-publication-v1" &&
      semantic.provenance?.provider === "unavailable" &&
      semantic.provenance?.terminalVerdict === "not_checked" &&
      Array.isArray(semantic.claimVerdicts) &&
      semantic.claimVerdicts.every((verdict) =>
        verdict?.verdict === "unknown" && verdict?.reasonCode === "semantic_provider_unavailable",
      )
  );
}

export function attestAutopilotItemForHumanApproval(item, { userId, attestedAt } = {}) {
  if (!isAutopilotHumanReviewItem(item)) return item;
  const id = Number(userId);
  const timestamp = new Date(attestedAt ?? Date.now());
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(timestamp.getTime())) return item;
  const humanAttestation = Object.freeze({
    kind: "human_review",
    reviewState: "semantic_only_review",
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
      attestation.reviewState === "semantic_only_review" &&
      Number.isSafeInteger(attestation.userId) &&
      attestation.userId > 0 &&
      attestation.qualityCheckedAt === item.quality.metadata.checkedAt,
  );
}

export { hardQualityViolations };
