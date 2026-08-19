// Pure approval policy shared by the Next.js API and the standalone worker.
// The quality metadata verifier is the single source of truth in every entry point.

import {
  hasAutomaticQualityApproval,
  hasHumanQualityAttestation,
  hasVerifiedQualityMetadata,
  withHumanQualityAttestation,
} from "./post-quality.mjs";
import { createHash, randomBytes } from "node:crypto";

export const AUTOPILOT_FRESHNESS_MS = 60_000;
export const AUTOPILOT_PREVIEW_TTL_MS = 5 * 60_000;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value ?? null;
}

export function canonicalAutopilotPlanSnapshot({ items, planId, planRevision, channelId }) {
  return stableValue({
    planId: Number(planId),
    planRevision: Number(planRevision),
    channelId: Number(channelId),
    items: (Array.isArray(items) ? items : []).map((item) => ({
      i: Number(item?.i),
      scheduledAt: typeof item?.scheduledAt === "string" ? item.scheduledAt : null,
      topic: typeof item?.topic === "string" ? item.topic : "",
      draft: typeof item?.draft === "string" ? item.draft : "",
      status: typeof item?.status === "string" ? item.status : "",
      postId: Number.isSafeInteger(Number(item?.postId)) ? Number(item.postId) : null,
      qualityBlocked: item?.qualityBlocked === true,
      invented: Array.isArray(item?.invented) ? item.invented.map(String) : [],
      quality: item?.quality ?? null,
      approvalBlockers: Array.isArray(item?.approvalBlockers) ? item.approvalBlockers : [],
    })),
  });
}

export function autopilotPlanRevisionHash(input) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalAutopilotPlanSnapshot(input)), "utf8")
    .digest("hex");
}

export function createAutopilotPreviewToken(bytes = 18) {
  return randomBytes(Math.max(12, Math.min(32, Number(bytes) || 18))).toString("base64url");
}

export function hashAutopilotPreviewToken(token) {
  return createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

const messages = {
  expired: "Время публикации уже прошло или наступит меньше чем через минуту. Выберите новую дату.",
  invalid_schedule: "Дата публикации повреждена. Выберите новую дату.",
  empty_draft: "Черновик пуст. Добавьте текст перед одобрением.",
  quality_missing: "Пост ещё не прошёл фактическую проверку качества.",
  quality_failed: "Пост не прошёл проверку качества.",
  semantic_review_required: "Автопроверка фактов не отработала. Прочитай текст и нажми «Одобрить».",
};

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

function qualityIsComplete(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.score === "number" &&
      Number.isFinite(value.score) &&
      typeof value.threshold === "number" &&
      Number.isFinite(value.threshold) &&
      typeof value.passed === "boolean" &&
      Array.isArray(value.blockers) &&
      Array.isArray(value.violations) &&
      hasVerifiedQualityMetadata(value),
  );
}

function blocker(code, detail) {
  return { code, message: detail || messages[code] };
}

/**
 * Decide whether one plan item may be scheduled without mutating it.
 * Non-pending/already scheduled items are ignored rather than reported as blocked.
 */
export function evaluateAutopilotItem(item, nowMs = Date.now(), options = {}) {
  const actionable = item?.status === "pending" && !item?.postId;
  if (!actionable) {
    return {
      actionable: false,
      eligible: false,
      scheduledAt: typeof item?.scheduledAt === "string" ? item.scheduledAt : null,
      blockers: [],
    };
  }

  const blockers = [];
  const scheduledAt = typeof item.scheduledAt === "string" ? item.scheduledAt : "";
  const scheduledMs = Date.parse(scheduledAt);
  if (!Number.isFinite(scheduledMs)) {
    blockers.push(blocker("invalid_schedule"));
  } else if (scheduledMs < nowMs + AUTOPILOT_FRESHNESS_MS) {
    blockers.push(blocker("expired"));
  }

  if (typeof item.draft !== "string" || item.draft.trim().length === 0) {
    blockers.push(blocker("empty_draft"));
  }

  if (!qualityIsComplete(item.quality)) {
    blockers.push(blocker("quality_missing"));
  } else if (
    hasAutomaticQualityApproval(item.quality) ||
    hasHumanQualityAttestation(item.quality)
  ) {
    // Automatic proof or an explicit human review both clear the quality gate.
  } else if (isAutopilotHumanReviewItem(item) && options.actor === "human") {
    // Confirmation-mode click is the review. Full-auto never passes actor: "human".
  } else if (
    isAutopilotHumanReviewItem(item) ||
    (item.quality.passed === true && !hasAutomaticQualityApproval(item.quality))
  ) {
    blockers.push(blocker("semantic_review_required"));
  } else {
    const qualityFailed =
      item.quality.passed !== true ||
      hardQualityViolations(item.quality).length > 0 ||
      item.qualityBlocked === true ||
      (Array.isArray(item.invented) && item.invented.length > 0);
    if (qualityFailed) {
      const detail =
        item.quality.blockers.find((entry) => typeof entry === "string" && entry.trim()) ||
        hardQualityViolations(item.quality)[0]?.message;
      blockers.push(blocker("quality_failed", detail));
    }
  }

  return {
    actionable: true,
    eligible: blockers.length === 0,
    scheduledAt: scheduledAt || null,
    blockers,
  };
}

/** Persistable, immutable annotation of unsafe items. */
export function annotateAutopilotItems(items, nowMs = Date.now(), options = {}) {
  return (Array.isArray(items) ? items : []).map((source) => {
    const item = { ...source };
    const evaluation = evaluateAutopilotItem(item, nowMs, options);
    if (!evaluation.actionable) return item;

    if (evaluation.blockers.length === 0) {
      delete item.approvalBlockers;
      return item;
    }

    item.approvalBlockers = evaluation.blockers.map((entry) => ({ ...entry }));
    if (evaluation.blockers.some((entry) => entry.code === "expired" || entry.code === "invalid_schedule")) {
      item.status = "expired";
    }
    if (
      evaluation.blockers.some((entry) =>
        ["quality_missing", "quality_failed", "semantic_review_required", "empty_draft"].includes(entry.code),
      )
    ) {
      item.qualityBlocked = true;
    }
    return item;
  });
}

/** Build the exact information a human must see before bulk confirmation. */
export function buildAutopilotApprovalPreview({
  items,
  nowMs = Date.now(),
  channel,
  planId,
  planRevision = 1,
  expiresAtMs = nowMs + AUTOPILOT_PREVIEW_TTL_MS,
  actor,
}) {
  const evaluations = (Array.isArray(items) ? items : [])
    .map((item) => ({ item, evaluation: evaluateAutopilotItem(item, nowMs, { actor }) }))
    .filter(({ evaluation }) => evaluation.actionable);

  const dates = [];
  const blockers = [];
  let expired = 0;
  let blocked = 0;
  let eligible = 0;

  for (const { item, evaluation } of evaluations) {
    if (evaluation.eligible) {
      eligible += 1;
      dates.push({ index: item.i, scheduledAt: evaluation.scheduledAt });
      continue;
    }
    const hasExpired = evaluation.blockers.some((entry) =>
      entry.code === "expired" || entry.code === "invalid_schedule",
    );
    if (hasExpired) expired += 1;
    else blocked += 1;
    blockers.push({
      index: item.i,
      topic: typeof item.topic === "string" ? item.topic : "",
      scheduledAt: evaluation.scheduledAt,
      reasons: evaluation.blockers.map((entry) => ({ ...entry })),
    });
  }

  const snapshot = canonicalAutopilotPlanSnapshot({
    items,
    planId,
    planRevision,
    channelId: channel?.id,
  });
  return {
    planId: Number(planId),
    revision: Number(planRevision),
    hash: autopilotPlanRevisionHash({ items, planId, planRevision, channelId: channel?.id }),
    channel: {
      id: Number(channel?.id),
      title: channel?.title || null,
      handle: channel?.handle || null,
    },
    counts: { total: evaluations.length, eligible, expired, blocked },
    dates,
    blockers,
    items: snapshot.items,
    generatedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    requiresConfirmation: eligible > 0,
  };
}

/**
 * Execute only policy-approved items through injected side effects. The returned items are
 * a retry-safe checkpoint: successful postIds are retained and never selected again.
 */
export async function executeAutopilotApproval({
  items,
  nowMs = Date.now(),
  schedule,
  onCheckpoint,
  attestor,
}) {
  const prepared = (Array.isArray(items) ? items : []).map((item) => (
    attestor
      ? attestAutopilotItemForHumanApproval(item, {
          userId: attestor.userId,
          attestedAt: attestor.attestedAt || new Date(nowMs).toISOString(),
        })
      : item
  ));
  const safeItems = annotateAutopilotItems(prepared, nowMs);
  let scheduled = 0;
  try {
    for (const item of safeItems) {
      const evaluation = evaluateAutopilotItem(item, nowMs);
      if (!evaluation.eligible || !evaluation.scheduledAt) continue;
      const postId = await schedule(item, evaluation.scheduledAt);
      if (!Number.isInteger(Number(postId)) || Number(postId) <= 0) {
        throw new Error("invalid_post_id");
      }
      item.postId = Number(postId);
      item.status = "approved";
      scheduled += 1;
      if (onCheckpoint) await onCheckpoint(safeItems, item, scheduled);
    }
    return { items: safeItems, scheduled, error: null };
  } catch (error) {
    return { items: safeItems, scheduled, error };
  }
}
