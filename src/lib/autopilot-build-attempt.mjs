import { autopilotBuildProgress, autopilotRetryableItemIndexes } from "./autopilot-build-progress.mjs";
import { autopilotQualityFailureReport } from "./autopilot-quality-report.mjs";
import { isAutopilotReaderReadyItem } from "./autopilot-review.mjs";
import { normalizeAutopilotQuickSettings } from "./autopilot-style.mjs";
import { sanitizeAutopilotPublicText } from "./autopilot-publication.mjs";

const PRIVATE_KEYS = new Set([
  "_support",
  "_system",
  "_task",
  "_outputTokens",
  "autoApprove",
  "prompt",
  "systemPrompt",
  "sourceEmbedding",
  "sourceEmbeddings",
  "stack",
]);

function publicValue(value) {
  if (Array.isArray(value)) return value.map(publicValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.startsWith("_") && !PRIVATE_KEYS.has(key))
      .map(([key, nested]) => [key, publicValue(nested)]),
  );
}

function serializePublicQuality(source) {
  if (!source || typeof source !== "object") return undefined;
  const metadata = source.metadata && typeof source.metadata === "object" ? source.metadata : {};
  const provenance = metadata.provenance && typeof metadata.provenance === "object"
    ? metadata.provenance
    : {};
  const semantic = source.semantic && typeof source.semantic === "object" ? source.semantic : null;
  return publicValue({
    score: Number(source.score || 0),
    threshold: Number(source.threshold || 0),
    passed: source.passed === true,
    blockers: Array.isArray(source.blockers) ? source.blockers.map(String).slice(0, 20) : [],
    violations: Array.isArray(source.violations)
      ? source.violations.slice(0, 30).map((violation) => ({
          code: String(violation?.code || "unknown"),
          message: String(violation?.message || "Пост требует проверки").slice(0, 500),
          blocker: violation?.blocker === true,
        }))
      : [],
    publicationDisposition: source.publicationDisposition || undefined,
    repairStrategy: source.repairStrategy || undefined,
    desiredLength: source.desiredLength || undefined,
    publicationEnvelope: source.publicationEnvelope || undefined,
    metadata: {
      checkedAt: metadata.checkedAt,
      rules: metadata.rules,
      provenance: {
        kind: provenance.kind,
        validator: provenance.validator,
        trigger: provenance.trigger,
        humanAttestation: provenance.humanAttestation || null,
      },
    },
    semantic: semantic
      ? {
          version: semantic.version,
          status: semantic.status,
          passed: semantic.passed === true,
          requiresReview: semantic.requiresReview === true,
          claimVerdicts: Array.isArray(semantic.claimVerdicts)
            ? semantic.claimVerdicts.slice(0, 100).map((verdict) => ({
                verdict: verdict?.verdict,
                reasonCode: verdict?.reasonCode,
                // Text of the claim and source identifiers are worker diagnostics. The UI
                // needs only the structural verdict to enforce the human-review boundary.
                sourceSpans: Array.isArray(verdict?.sourceSpans)
                  ? verdict.sourceSpans.map((span) => ({ start: span?.start, end: span?.end }))
                  : [],
              }))
            : [],
          provenance: {
            validatorVersion: semantic.provenance?.validatorVersion,
            checkedAt: semantic.provenance?.checkedAt,
            provider: semantic.provenance?.provider === "unavailable" ? "unavailable" : "verified",
            terminalVerdict: semantic.provenance?.terminalVerdict,
          },
        }
      : undefined,
  });
}

/** An explicit allow-list keeps prompts and transient worker decisions out of the API. */
export function serializeAutopilotPublicItem(source) {
  const item = source && typeof source === "object" ? source : {};
  return publicValue({
    i: Number(item.i),
    scheduledAt: typeof item.scheduledAt === "string" ? item.scheduledAt : null,
    topic: typeof item.topic === "string" ? item.topic : "",
    rubric: typeof item.rubric === "string" ? item.rubric : null,
    draft: sanitizeAutopilotPublicText(item.draft),
    status: typeof item.status === "string" ? item.status : "pending",
    aiReady: item.aiReady === true,
    invented: Array.isArray(item.invented) ? item.invented.map(String).slice(0, 20) : undefined,
    qualityBlocked: item.qualityBlocked === true,
    quality: serializePublicQuality(item.quality),
    qualityOrigin: typeof item.qualityOrigin === "string" ? item.qualityOrigin : undefined,
    approvalBlockers: Array.isArray(item.approvalBlockers) ? item.approvalBlockers : undefined,
    reviewRequired: item.reviewRequired === true,
    reviewState: typeof item.reviewState === "string" ? item.reviewState : undefined,
    reviewReason: typeof item.reviewReason === "string" ? item.reviewReason : undefined,
    draftId: Number.isSafeInteger(Number(item.draftId)) ? Number(item.draftId) : undefined,
    postId: Number.isSafeInteger(Number(item.postId)) ? Number(item.postId) : undefined,
    monthlyCampaignItemId: Number.isSafeInteger(Number(item.monthlyCampaignItemId))
      ? Number(item.monthlyCampaignItemId)
      : undefined,
    monthlyCampaignItemVersion: Number.isSafeInteger(Number(item.monthlyCampaignItemVersion))
      ? Number(item.monthlyCampaignItemVersion)
      : undefined,
  });
}

export function serializeAutopilotActivePlan(row, items = row?.items) {
  if (!row) return null;
  return {
    id: Number(row.id),
    revision: Number(row.revision || 1),
    weekStart: row.week_start ? String(row.week_start).slice(0, 10) : null,
    items: (Array.isArray(items) ? items : []).map(serializeAutopilotPublicItem),
    rules: typeof row.rules === "string" ? row.rules : null,
    status: String(row.status || "pending"),
    generationEngine: String(row.generation_engine || ""),
    planningMonths: Number(row.planning_months || 1),
    planningWeeks: Number(row.planning_weeks || 1),
    expectedPostCount: Number(row.expected_post_count || 0),
    publicationTargetCount: Number(row.publication_target_count || row.expected_post_count || 0),
    candidateCount: Number(row.candidate_count || row.expected_post_count || 0),
    quickSettings: normalizeAutopilotQuickSettings(row.quick_settings),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: new Date(row.build_activity_at || row.created_at).toISOString(),
  };
}

export function autopilotBuildAttemptDto(row, expected) {
  if (!row) return null;
  const items = Array.isArray(row.items) ? row.items : [];
  const publicationTargetCount = Math.max(
    0,
    Number(row.publication_target_count || row.expected_post_count) || items.length,
  );
  const candidateCount = Math.max(
    publicationTargetCount,
    Number(expected ?? row.candidate_count ?? row.expected_post_count) || items.length,
  );
  // Candidate reserve is an internal quality mechanism. Public progress follows the
  // promise the person made: the exact number of posts requested for publication.
  const targetCount = publicationTargetCount;
  const report = autopilotQualityFailureReport(items, candidateCount);
  const measuredProgress = autopilotBuildProgress(items, candidateCount);
  const readyForPlan = Math.min(publicationTargetCount, measuredProgress.ready);
  const progress = {
    ...measuredProgress,
    completed: readyForPlan,
    total: publicationTargetCount,
    ready: readyForPlan,
    percent: publicationTargetCount
      ? Math.min(100, Math.round(readyForPlan / publicationTargetCount * 100))
      : 0,
    stage: readyForPlan >= publicationTargetCount && publicationTargetCount > 0
      ? "finalizing"
      : readyForPlan > 0
        ? "generating"
        : "preparing",
  };
  const persistedReport = row.build_report && typeof row.build_report === "object"
    ? row.build_report
    : null;
  const selectionDeficit = Math.max(
    0,
    Number(persistedReport?.selectionDeficit) || publicationTargetCount - progress.ready,
  );
  const retryableItemIndexes = autopilotRetryableItemIndexes(items)
    .sort((left, right) => Number(items[right]?.news === true) - Number(items[left]?.news === true))
    .slice(0, selectionDeficit);
  const causes = Array.isArray(persistedReport?.causes) && persistedReport.causes.length
    ? persistedReport.causes
    : report.causes;
  const status = String(row.status || "building");
  const recoveryState = ["waiting_provider", "provider_stopped"].includes(
    String(persistedReport?.recoveryState || ""),
  )
    ? String(persistedReport.recoveryState)
    : null;
  return {
    planId: Number(row.id),
    revision: Number(row.revision || 1),
    status,
    targetCount,
    publicationTargetCount,
    candidateCount,
    readyCount: progress.ready,
    failedCount: status === "building"
      ? progress.failed
      : Math.max(progress.failed, targetCount - progress.ready),
    progress,
    causes: causes.slice(0, 3).map((cause) => ({
      code: String(cause.code || "unknown"),
      count: Number(cause.count || 0),
      title: String(cause.title || "Пост требует проверки"),
      action: String(cause.action || "Открой пост и проверь замечание."),
      publicationDisposition: cause.publicationDisposition || "blocked",
      repairStrategy: cause.repairStrategy || "human_review",
    })),
    primaryFix: persistedReport?.primaryFix || row.repair_strategy || report.primaryFix,
    recoveryState,
    providerFailureCode: typeof persistedReport?.providerFailureCode === "string"
      ? persistedReport.providerFailureCode
      : null,
    attemptNumber: Math.max(0, Number(persistedReport?.attemptNumber) || 0),
    maxAttempts: Math.max(0, Number(persistedReport?.maxAttempts) || 0),
    nextRetryAt: typeof persistedReport?.nextRetryAt === "string"
      ? persistedReport.nextRetryAt
      : null,
    retryableItemIndexes,
    readerReadyItems: items
      .filter(isAutopilotReaderReadyItem)
      .map(serializeAutopilotPublicItem),
    errorReason: typeof row.errorReason === "string" ? row.errorReason : null,
    updatedAt: new Date(row.build_activity_at || row.created_at).toISOString(),
  };
}
