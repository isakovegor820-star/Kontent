import type { Pool, PoolClient } from "pg";

import { getPool } from "./db";
import { normalizeDraftAiValidation } from "./draft-review";
import { extractSemanticClaims } from "./semantic-claims.mjs";
import { requireSelectedProjectPermission } from "./project-permissions";

type Queryable = Pick<Pool | PoolClient, "query">;
export type EvidenceSubjectKind = "draft" | "opportunity";
export type EvidenceStatus = "passed" | "needs_review" | "blocked" | "not_checked" | "stale";

export type EvidenceProjection = {
  subject: { kind: EvidenceSubjectKind; id: number; version: number; label: string; contentHash: string | null };
  status: EvidenceStatus;
  statusLabel: string;
  summary: string;
  source: { label: string; href: string | null; observedAt: string | null; freshness: string } | null;
  anomaly: { state: "observed" | "inferred" | "insufficient_data"; explanation: string; formulaVersion: string | null };
  claims: Array<{
    id: string; text: string; status: "supported" | "needs_review" | "unsupported" | "not_checkable";
    sourceLabels: string[]; validatorVersion: string | null; checkedAt: string | null;
    impact: "none" | "review_required" | "blocks_publish";
  }>;
  originality: { status: "not_checked"; explanation: string; contentHash: string | null };
  humanAction: string;
};

export class EvidenceProjectionError extends Error {
  constructor(public readonly code: "not_found" | "bad_subject") {
    super(code); this.name = "EvidenceProjectionError";
  }
}

function safeHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch { return null; }
}

function sourceRef(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function freshness(value: string | null): string {
  if (!value) return "Свежесть неизвестна";
  const hours = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 3_600_000));
  if (!Number.isFinite(hours)) return "Свежесть неизвестна";
  return hours < 24 ? `Проверено ${hours || "меньше 1"} ч назад` : `Проверено ${Math.floor(hours / 24)} дн. назад`;
}

async function opportunityProjection(db: Queryable, projectId: number, id: number): Promise<EvidenceProjection | null> {
  const row = (await db.query<{
    id: string; revision: number; title: string; confidence: string; epistemic_state: string; formula_version: string;
    evidence: Record<string, unknown>; observed_at: string | null; expires_at: string; fingerprint: string;
  }>(`select id, revision, title, confidence, epistemic_state, formula_version, evidence,
             observed_at::text, expires_at::text, fingerprint
        from opportunity_snapshots where id = $1 and project_id = $2`, [id, projectId])).rows[0];
  if (!row) return null;
  const expired = new Date(row.expires_at).getTime() <= Date.now();
  const href = safeHref(row.evidence?.sourceHref);
  const label = typeof row.evidence?.sourceLabel === "string" ? row.evidence.sourceLabel : "Источник возможности";
  return {
    subject: { kind: "opportunity", id: Number(row.id), version: Number(row.revision), label: row.title, contentHash: row.fingerprint },
    status: expired ? "stale" : row.confidence === "low" ? "needs_review" : "passed",
    statusLabel: expired ? "Сигнал устарел" : row.confidence === "low" ? "Данных мало" : "Основание доступно",
    summary: typeof row.evidence?.metricLabel === "string" ? row.evidence.metricLabel : "Метрика источника не сохранена",
    source: { label, href, observedAt: row.observed_at, freshness: expired ? "Сигнал устарел" : freshness(row.observed_at) },
    anomaly: {
      state: row.epistemic_state === "insufficient_data" ? "insufficient_data" : "inferred",
      explanation: typeof row.evidence?.methodology === "string" ? row.evidence.methodology : "Методика не сохранена",
      formulaVersion: row.formula_version,
    },
    claims: [],
    originality: { status: "not_checked", explanation: "Оригинальность проверяется после создания точной версии текста.", contentHash: null },
    humanAction: expired ? "Обновите карту перед созданием материала." : "Откройте источник и проверьте угол перед генерацией.",
  };
}

async function draftProjection(db: Queryable, projectId: number, id: number): Promise<EvidenceProjection | null> {
  const row = (await db.query<{
    id: string; version: string; text: string; source_ref: unknown; purpose: string; origin: string;
    content_hash: string | null; result_hash: string | null; receipt_hash: string | null; receipt: unknown;
    source_ref_upstream: unknown; source_updated_at: string | null; opportunity_observed_at: string | null;
    opportunity_formula: string | null; opportunity_evidence: Record<string, unknown> | null;
  }>(
    `select draft.id, draft.version, draft.text, draft.source_ref, draft.purpose, draft.origin,
            revision.content_hash, result.result_hash, receipt.result_hash as receipt_hash, receipt.receipt,
            source_draft.source_ref as source_ref_upstream, source_draft.updated_at::text as source_updated_at,
            opportunity.observed_at::text as opportunity_observed_at,
            opportunity.formula_version as opportunity_formula, opportunity.evidence as opportunity_evidence
       from drafts draft
       left join draft_revisions revision on revision.draft_id = draft.id and revision.draft_version = draft.version
       left join generation_results result on result.id = draft.generation_result_id
       left join validation_receipts receipt on receipt.generation_result_id = result.id
       left join generation_operations operation on operation.id = result.operation_id
       left join drafts source_draft on source_draft.id = operation.source_context_id and source_draft.project_id = draft.project_id
       left join opportunity_snapshots opportunity on opportunity.source_context_draft_id = source_draft.id and opportunity.project_id = draft.project_id
      where draft.id = $1 and draft.project_id = $2`,
    [id, projectId],
  )).rows[0];
  if (!row) return null;
  const receipt = normalizeDraftAiValidation(row.receipt);
  const stale = Boolean(row.result_hash && row.content_hash && row.result_hash !== row.content_hash);
  const status: EvidenceStatus = stale ? "stale" : receipt?.status === "passed" ? "passed"
    : receipt?.status === "blocked" ? "blocked" : receipt?.status === "not_checked" ? "needs_review" : "not_checked";
  const ref = sourceRef(row.source_ref_upstream) ?? sourceRef(row.source_ref);
  const provenance = sourceRef(ref?.provenance);
  const sourceLabel = typeof ref?.label === "string" ? ref.label : "Источник не сохранён";
  const checkedAt = receipt?.provenance.checkedAt ?? null;
  const claims = extractSemanticClaims(row.text).slice(0, 12).map((claim) => ({
    id: claim.id,
    text: claim.text,
    status: status === "passed" ? "supported" as const : status === "blocked" ? "unsupported" as const
      : status === "needs_review" || status === "stale" ? "needs_review" as const : "not_checkable" as const,
    sourceLabels: receipt?.provenance.sourceIds ?? [],
    validatorVersion: receipt?.provenance.validatorVersion ?? null,
    checkedAt,
    impact: status === "blocked" ? "blocks_publish" as const
      : status === "passed" ? "none" as const : "review_required" as const,
  }));
  const statusLabel = ({ passed: "Проверка пройдена", blocked: "Публикация заблокирована", needs_review: "Нужна проверка", not_checked: "Проверка недоступна", stale: "Проверка устарела" } as const)[status];
  return {
    subject: { kind: "draft", id: Number(row.id), version: Number(row.version), label: "Доказательства черновика", contentHash: row.content_hash },
    status, statusLabel,
    summary: status === "passed" ? "Сервер связал проверку с этой точной версией текста."
      : status === "blocked" ? "Есть утверждения, которые нельзя публиковать без исправления."
        : "Без новой проверки эта версия требует внимания человека.",
    source: ref ? {
      label: sourceLabel, href: safeHref(provenance?.url),
      observedAt: row.opportunity_observed_at ?? row.source_updated_at,
      freshness: freshness(row.opportunity_observed_at ?? row.source_updated_at),
    } : null,
    anomaly: {
      state: row.opportunity_evidence ? "inferred" : "insufficient_data",
      explanation: typeof row.opportunity_evidence?.methodology === "string"
        ? row.opportunity_evidence.methodology : "Для этого черновика необычность сигнала не рассчитывалась.",
      formulaVersion: row.opportunity_formula,
    },
    claims,
    originality: {
      status: "not_checked",
      explanation: "Отдельный originality receipt пока не создан — Аврора не утверждает, что текст оригинален.",
      contentHash: row.content_hash,
    },
    humanAction: status === "blocked" ? "Исправьте или удалите неподтверждённые утверждения и запустите новую проверку."
      : status === "passed" ? "Перед публикацией проверьте смысл и актуальность источника."
        : "Прочитайте утверждения и запросите проверку точной версии.",
  };
}

export async function loadEvidenceProjection(input: {
  actorUserId: number; kind: EvidenceSubjectKind; id: number;
}, db: Queryable = getPool()): Promise<EvidenceProjection> {
  if (!Number.isSafeInteger(input.id) || input.id <= 0 || !["draft", "opportunity"].includes(input.kind)) {
    throw new EvidenceProjectionError("bad_subject");
  }
  const membership = await requireSelectedProjectPermission(db, input.actorUserId, "project.read");
  const projection = input.kind === "draft"
    ? await draftProjection(db, membership.projectId, input.id)
    : await opportunityProjection(db, membership.projectId, input.id);
  if (!projection) throw new EvidenceProjectionError("not_found");
  return projection;
}
