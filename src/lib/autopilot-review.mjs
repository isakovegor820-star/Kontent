import {
  hasAutomaticQualityApproval,
  hasHumanQualityAttestation,
  hasVerifiedQualityMetadata,
  withHumanQualityAttestation,
} from "./post-quality.mjs";

function hardQualityViolations(quality) {
  return (Array.isArray(quality?.violations) ? quality.violations : [])
    .filter((violation) => violation?.blocker === true && violation.code !== "semantic_review_required");
}

/**
 * Editorial rules passed, but claim-level auto-check did not. A person may approve
 * this draft; full-auto and unattended publication may not.
 */
export function isAutopilotHumanReviewItem(item) {
  if (item?.aiReady === false) return false;
  if (!hasVerifiedQualityMetadata(item?.quality)) return false;
  if (Array.isArray(item.invented) && item.invented.length > 0) return false;
  if (hasAutomaticQualityApproval(item.quality)) return false;
  if (hasHumanQualityAttestation(item.quality)) return false;
  if (item.quality.semantic?.status === "blocked") return false;
  if (hardQualityViolations(item.quality).length > 0) return false;
  return item.quality.semantic?.status === "not_checked" ||
    item.reviewRequired === true ||
    (Array.isArray(item.quality.violations) &&
      item.quality.violations.some((violation) => violation?.code === "semantic_review_required"));
}

export function reconcileAutopilotReviewQuality(quality) {
  if (!quality || typeof quality !== "object") return quality;
  const violations = (Array.isArray(quality.violations) ? quality.violations : [])
    .map((violation) => (
      violation?.code === "semantic_review_required"
        ? { ...violation, blocker: false }
        : violation
    ));
  const blockers = (Array.isArray(quality.blockers) ? quality.blockers : [])
    .filter((message) => !/не проверен|не подтвержд|не отработала/iu.test(String(message)));
  const threshold = Number(quality.threshold);
  const score = Number(quality.score);
  return {
    ...quality,
    passed: true,
    score: Number.isFinite(score) && Number.isFinite(threshold)
      ? Math.max(score, threshold)
      : score,
    blockers,
    violations,
  };
}

export function attestAutopilotItemForHumanApproval(item, { userId, attestedAt } = {}) {
  if (!isAutopilotHumanReviewItem(item)) return item;
  const quality = withHumanQualityAttestation(
    reconcileAutopilotReviewQuality(item.quality),
    { userId, attestedAt },
  );
  if (!hasHumanQualityAttestation(quality)) return item;
  return {
    ...item,
    quality,
    qualityOrigin: "human_attested",
    qualityBlocked: false,
    reviewRequired: false,
  };
}

export { hardQualityViolations };
