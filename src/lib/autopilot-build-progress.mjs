const PRIVATE_ITEM_KEYS = new Set([
  "_support",
  "_system",
  "_task",
  "_outputTokens",
  "_rewriteAttempts",
  // This is a transient decision made while generating. Persisting it across a retry can
  // publish a post after the user has switched from full-auto back to confirmation mode.
  "autoApprove",
]);

const PROVIDER_WAITING_DISCARDED_KEYS = new Set([
  ...PRIVATE_ITEM_KEYS,
  "draft",
  "quality",
  "qualityOrigin",
  "sources",
  "cited",
  "invented",
  "presentation",
  "approvalBlockers",
  "humanAttestation",
  "reviewState",
  "reviewReason",
  "_providerFailure",
]);

// Production load checks currently put a completed post in the 6–8 second range when
// several drafts are generated in parallel. Keep a range instead of showing a precise
// countdown: provider load and fallback attempts can legitimately move the finish time.
const AUTOPILOT_BUILD_SECONDS_PER_POST = Object.freeze({ min: 6, max: 8 });

export function estimateAutopilotBuildMinutes(total, completed = 0) {
  const safeTotal = Math.max(0, Math.floor(Number(total) || 0));
  const safeCompleted = Math.min(
    safeTotal,
    Math.max(0, Math.floor(Number(completed) || 0)),
  );
  const remaining = safeTotal - safeCompleted;
  if (!remaining) return { min: 0, max: 0 };

  return {
    min: Math.max(1, Math.ceil(remaining * AUTOPILOT_BUILD_SECONDS_PER_POST.min / 60)),
    max: Math.max(1, Math.ceil(remaining * AUTOPILOT_BUILD_SECONDS_PER_POST.max / 60)),
  };
}

export function autopilotTopicCheckpoints(topics, slots, now = () => new Date()) {
  const checkpointedAt = now().toISOString();
  return (Array.isArray(topics) ? topics : []).map((topic, index) => ({
    i: index,
    scheduledAt: slots?.[index] || topic?.scheduledAt || null,
    topic: String(topic?.topic || ""),
    rubric: String(topic?.rubric || ""),
    ...(topic?.seed ? { seed: topic.seed } : {}),
    ...(topic?.news ? { news: topic.news } : {}),
    ...(topic?.monthlyCampaignItemId
      ? {
          monthlyCampaignItemId: topic.monthlyCampaignItemId,
          monthlyCampaignItemVersion: topic.monthlyCampaignItemVersion,
        }
      : {}),
    buildState: "queued",
    checkpointedAt,
  }));
}

export function autopilotCheckpointItem(item, now = () => new Date()) {
  const checkpoint = {};
  for (const [key, value] of Object.entries(item || {})) {
    if (!PRIVATE_ITEM_KEYS.has(key) && value !== undefined) checkpoint[key] = value;
  }
  return {
    ...checkpoint,
    buildState: item?.buildState === "waiting_provider"
      ? "waiting_provider"
      : isAutopilotReaderReadyItem(item)
        ? item?.reviewRequired === true
          ? "confirmation_required"
          : "ready"
        : "failed",
    checkpointedAt: now().toISOString(),
  };
}

export function autopilotProviderWaitingItem({
  item,
  topic,
  scheduledAt,
  error,
  now = () => new Date(),
}) {
  const source = item && typeof item === "object" ? item : {};
  const plannedTopic = topic && typeof topic === "object" ? topic : {};
  const checkpointedAt = now().toISOString();
  const checkpoint = {};
  for (const [key, value] of Object.entries(source)) {
    if (!PROVIDER_WAITING_DISCARDED_KEYS.has(key) && value !== undefined) checkpoint[key] = value;
  }
  return {
    ...checkpoint,
    i: Number.isSafeInteger(Number(source.i)) ? Number(source.i) : Number(plannedTopic.i || 0),
    scheduledAt: scheduledAt || source.scheduledAt || plannedTopic.scheduledAt || null,
    topic: String(plannedTopic.topic || source.topic || ""),
    rubric: String(plannedTopic.rubric || source.rubric || ""),
    ...(plannedTopic.seed ? { seed: plannedTopic.seed } : {}),
    ...(plannedTopic.news ? { news: plannedTopic.news } : {}),
    draft: "",
    status: "pending",
    aiReady: false,
    qualityBlocked: true,
    reviewRequired: false,
    buildState: "waiting_provider",
    _providerFailure: {
      code: String(error?.code || "provider_unavailable").slice(0, 80),
      engine: String(error?.engine || "").slice(0, 80),
      status: Number.isFinite(Number(error?.status)) ? Number(error.status) : 503,
      at: checkpointedAt,
    },
    checkpointedAt,
  };
}

export function reusableAutopilotCheckpoint(item, topic, scheduledAt) {
  if (!item || !["ready", "confirmation_required", "review_required"].includes(item.buildState)) return false;
  if (!isAutopilotReaderReadyItem(item)) return false;
  if (String(item.topic || "") !== String(topic?.topic || "")) return false;
  return String(item.scheduledAt || "") === String(scheduledAt || "");
}

export function autopilotBuildProgress(items, expected) {
  const list = Array.isArray(items) ? items : [];
  const total = Math.max(0, Number(expected) || list.length);
  const completed = list.filter((item) => isAutopilotReaderReadyItem(item)).length;
  const failed = list.filter((item) =>
    item?.buildState === "failed" || (
      item?.aiReady === true && String(item?.draft || "").trim() &&
      !isAutopilotReaderReadyItem(item)
    ),
  ).length;
  const reviewRequired = list.filter((item) => item?.reviewRequired === true).length;
  return {
    completed,
    total,
    reviewRequired,
    ready: completed,
    failed,
    percent: total ? Math.min(100, Math.round(completed / total * 100)) : 0,
    stage: completed >= total && total > 0 ? "finalizing" : completed > 0 ? "generating" : "preparing",
  };
}

export function autopilotRetryableItemIndexes(items) {
  return (Array.isArray(items) ? items : [])
    .flatMap((item, index) =>
      !isAutopilotReaderReadyItem(item) &&
      item?.status !== "approved" &&
      item?.status !== "published" &&
      !Number(item?.postId)
        ? [Number.isSafeInteger(Number(item?.i)) ? Number(item.i) : index]
        : [],
    );
}

export function autopilotBuildActivityAt(createdAt, items) {
  let latest = new Date(createdAt).getTime();
  for (const item of Array.isArray(items) ? items : []) {
    const checkpoint = new Date(item?.checkpointedAt || 0).getTime();
    if (Number.isFinite(checkpoint)) latest = Math.max(latest, checkpoint);
  }
  return Number.isFinite(latest) ? new Date(latest) : new Date(createdAt);
}
import { isAutopilotReaderReadyItem } from "./autopilot-review.mjs";
