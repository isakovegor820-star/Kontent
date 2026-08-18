const PRIVATE_ITEM_KEYS = new Set([
  "_support",
  "_system",
  "_task",
  "_outputTokens",
  // This is a transient decision made while generating. Persisting it across a retry can
  // publish a post after the user has switched from full-auto back to confirmation mode.
  "autoApprove",
]);

export function autopilotTopicCheckpoints(topics, slots, now = () => new Date()) {
  const checkpointedAt = now().toISOString();
  return (Array.isArray(topics) ? topics : []).map((topic, index) => ({
    i: index,
    scheduledAt: slots?.[index] || topic?.scheduledAt || null,
    topic: String(topic?.topic || ""),
    rubric: String(topic?.rubric || ""),
    ...(topic?.seed ? { seed: topic.seed } : {}),
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
    buildState: item?.reviewRequired === true ? "review_required" : "ready",
    checkpointedAt: now().toISOString(),
  };
}

export function reusableAutopilotCheckpoint(item, topic, scheduledAt) {
  if (!item || !["ready", "review_required"].includes(item.buildState)) return false;
  if (item.aiReady !== true || !String(item.draft || "").trim()) return false;
  if (String(item.topic || "") !== String(topic?.topic || "")) return false;
  return String(item.scheduledAt || "") === String(scheduledAt || "");
}

export function autopilotBuildProgress(items, expected) {
  const list = Array.isArray(items) ? items : [];
  const total = Math.max(0, Number(expected) || list.length);
  const completed = list.filter((item) =>
    item?.aiReady === true && String(item?.draft || "").trim().length > 0,
  ).length;
  const reviewRequired = list.filter((item) => item?.reviewRequired === true).length;
  return {
    completed,
    total,
    reviewRequired,
    percent: total ? Math.min(100, Math.round(completed / total * 100)) : 0,
    stage: completed >= total && total > 0 ? "finalizing" : completed > 0 ? "generating" : "preparing",
  };
}

export function autopilotBuildActivityAt(createdAt, items) {
  let latest = new Date(createdAt).getTime();
  for (const item of Array.isArray(items) ? items : []) {
    const checkpoint = new Date(item?.checkpointedAt || 0).getTime();
    if (Number.isFinite(checkpoint)) latest = Math.max(latest, checkpoint);
  }
  return Number.isFinite(latest) ? new Date(latest) : new Date(createdAt);
}
