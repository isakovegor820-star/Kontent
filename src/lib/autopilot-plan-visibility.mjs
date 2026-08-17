import { hasVerifiedQualityMetadata } from "./post-quality.mjs";

/**
 * Legacy automatic drafts predate the verifiable quality contract and must be rebuilt.
 * A modern draft that failed quality still has valid metadata and must remain visible so
 * the user can inspect and edit it instead of losing the whole plan behind a rebuild state.
 */
export function autopilotPlanNeedsQualityRebuild(items) {
  return (Array.isArray(items) ? items : []).some(
    (item) =>
      item?.status === "pending" &&
      item?.qualityOrigin === "automatic" &&
      !hasVerifiedQualityMetadata(item?.quality),
  );
}
