import { createHash } from "node:crypto";

import { normalizeSiteLimits } from "./site-crawler.mjs";
import { siteAnalysisErrorMessage, siteAnalysisErrorRetryable } from "./site-analysis-contract";
export { siteAnalysisErrorMessage, type SiteAnalysisStatus } from "./site-analysis-contract";
import type { SiteAnalysisStatus } from "./site-analysis-contract";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{11,127}$/u;

export function normalizeSiteAnalysisKey(value: unknown): string | null {
  const key = String(value || "").trim();
  return IDEMPOTENCY_KEY.test(key) ? key : null;
}

export function siteAnalysisFingerprint(input: {
  targetUrl: string;
  confirmedDomain: string;
  limits?: Record<string, unknown>;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      targetUrl: input.targetUrl,
      confirmedDomain: input.confirmedDomain,
      limits: normalizeSiteLimits(input.limits),
    }), "utf8")
    .digest("hex");
}

export type SiteAnalysisRow = {
  id: string | number;
  request_id: string;
  target_url: string;
  confirmed_domain: string;
  status: SiteAnalysisStatus;
  stage: string;
  progress: string | number;
  progress_detail: string | null;
  limits: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  prompt_version?: string | null;
  question_catalog_version?: string | null;
  snapshot_hash?: string | null;
  coverage_mode?: string | null;
  answered_count?: string | number | null;
  question_count?: string | number | null;
  error_code: string | null;
  error_message: string | null;
  attempts: string | number;
  run_revision: string | number;
  queue_confirmed_at: Date | string | null;
  server_now?: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
};

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function serializeSiteAnalysis(row: SiteAnalysisRow, includeResult = false) {
  return {
    id: Number(row.id),
    requestId: row.request_id,
    targetUrl: row.target_url,
    confirmedDomain: row.confirmed_domain,
    status: row.status,
    stage: row.stage,
    progress: Number(row.progress),
    detail: row.progress_detail,
    limits: row.limits,
    error: row.error_code
      ? {
          code: row.error_code,
          message: siteAnalysisErrorMessage(row.error_code),
          retryable: siteAnalysisErrorRetryable(row.error_code),
        }
      : null,
    attempts: Number(row.attempts),
    runRevision: Number(row.run_revision),
    queueConfirmedAt: iso(row.queue_confirmed_at),
    startedAt: iso(row.queue_confirmed_at) || iso(row.created_at),
    serverNow: iso(row.server_now) || new Date().toISOString(),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: iso(row.completed_at),
    promptVersion: row.prompt_version ?? null,
    questionCatalogVersion: row.question_catalog_version ?? null,
    snapshotHash: row.snapshot_hash ?? null,
    coverageMode: row.coverage_mode ?? "site_only",
    answeredCount: Number(row.answered_count ?? 0),
    questionCount: Number(row.question_count ?? 0),
    ...(includeResult ? { result: row.result ?? null } : {}),
  };
}
