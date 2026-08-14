"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  ExternalLink,
  FileSearch,
  Globe2,
  Link2,
  RefreshCw,
  SearchCode,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { Button } from "@/components/ui/button";
import { Badge, Card, Input } from "@/components/ui/primitives";
import { siteAnalysisErrorMessage, type SiteAnalysisStatus } from "@/lib/site-analysis-contract";
import {
  acquireStableSiteAnalysisKey,
  bindStableSiteAnalysisKey,
  releaseStableSiteAnalysisKey,
  siteAnalysisIntentFingerprint,
  type StableSiteAnalysisKey,
} from "@/lib/site-analysis-client-key";
import { cn } from "@/lib/utils";
import { SITE_INTERVIEW_CATEGORIES, SITE_INTERVIEW_QUESTIONS } from "@/lib/site-analysis/questions";

type Evidence = { url: string; label: string };
type Finding = {
  code?: string;
  severity?: "high" | "medium" | "low";
  title: string;
  description?: string;
  evidence?: Evidence[];
  confidence?: string;
};
type PlanTask = {
  title?: string;
  action?: string;
  rationale?: string;
  priority?: string;
  dueDays?: number;
  sources?: Evidence[];
  confidence?: string;
};
type PlanConclusion = {
  title?: string;
  description?: string;
  statement?: string;
  stage?: string;
  action?: string;
  channel?: string;
  reason?: string;
  kpi?: string;
  target?: string;
  sources?: Evidence[];
  confidence?: string;
};
type SiteReport = {
  policyVersion?: string;
  inventory?: Array<{ url: string; status: number; title?: string; words?: number; schemaTypes?: string[] }>;
  seoAudit?: Finding[];
  geoAudit?: Finding[];
  themes?: Array<{ theme: string; occurrences: number; evidence?: Evidence[]; confidence?: string }>;
  intents?: Array<{ id: string; label: string; pages: number; evidence?: Evidence[]; confidence?: string }>;
  internalLinking?: { totalLinks?: number; orphanCandidates?: Array<{ url: string }> };
  marketingPlan?: {
    goals?: PlanConclusion[];
    icp?: PlanConclusion;
    funnel?: PlanConclusion[];
    positioning?: PlanConclusion;
    contentGaps?: PlanTask[];
    seoTasks?: PlanTask[];
    geoTasks?: PlanTask[];
    promotionChannels?: PlanConclusion[];
    publicationBacklog?: PlanTask[];
    measurement?: Array<{ kpi: string; sourceNeeded: string; confidence: string }>;
  };
  limitations?: string[];
  osint?: OsintReport;
  snapshot?: EvidenceSnapshot;
};
type OsintStatus = "answered" | "hypothesis" | "conflicting" | "insufficient_data";
type OsintConfidence = "high" | "medium" | "low" | "none";
type OsintAnswer = {
  questionId: string;
  status: OsintStatus;
  shortAnswer: string;
  explanation: string;
  facts: Array<{ statement: string; evidenceIds: string[] }>;
  evidenceIds: string[];
  confidence: OsintConfidence;
  contradictions: Array<{ description: string; evidenceIds: string[] }>;
  gaps: string[];
  requiredIntegrations: string[];
  recommendationHooks: Array<{ kind: string; rationale: string; entityIds: string[]; evidenceIds: string[] }>;
};
type OsintReport = {
  reportStatus: "complete";
  promptVersion?: string;
  questionCatalogVersion?: string;
  snapshotHash?: string;
  coverage?: { mode?: string; limitations?: string[] };
  answers: OsintAnswer[];
  summary: { answered: number; hypothesis: number; conflicting: number; insufficientData: number; total: number };
  recommendations?: Array<{ key: string; questionId: string; kind: string; rationale: string; confidence: OsintConfidence; entityIds: string[]; evidenceIds: string[] }>;
  marketingPlan?: {
    publicationBacklog?: Array<{ key: string; questionId: string; kind: string; rationale: string; confidence: OsintConfidence; evidenceIds: string[]; priority: string; order: number }>;
    measurement?: Array<{ kpi: string; requiredIntegration: string; confidence: string }>;
  };
};
type SnapshotSource = {
  id: string;
  kind: string;
  url: string;
  title: string;
  pageType?: string;
  checkedAt?: string;
  publishedAt?: string | null;
  modifiedAt?: string | null;
  quality?: string;
};
type SnapshotEvidence = {
  id: string;
  sourceId: string;
  type: string;
  value: unknown;
  factType?: string;
  quality?: string;
  currentness?: string;
  checkedAt?: string;
  publishedAt?: string | null;
};
type EvidenceSnapshot = {
  version?: string;
  snapshotHash?: string;
  coverage?: { mode?: string; limitations?: string[] };
  sources?: SnapshotSource[];
  evidence?: SnapshotEvidence[];
  entities?: Array<{ id: string; type: string; name: string; confidence?: string }>;
  relations?: Array<Record<string, unknown>>;
};
type Analysis = {
  id: number;
  requestId: string;
  targetUrl: string;
  confirmedDomain: string;
  status: SiteAnalysisStatus;
  stage: string;
  progress: number;
  detail: string | null;
  error: { code: string; message: string } | null;
  attempts: number;
  runRevision: number;
  startedAt: string | null;
  serverNow: string | null;
  clientReceivedAt?: number;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  promptVersion?: string | null;
  questionCatalogVersion?: string | null;
  snapshotHash?: string | null;
  coverageMode?: string;
  answeredCount?: number;
  questionCount?: number;
  result?: SiteReport | null;
};
type RunComparison = {
  currentRevision: number;
  previousRevision: number | null;
  new: string[];
  changed: string[];
  disappeared: string[];
  unchanged: number;
};

const TERMINAL = new Set<SiteAnalysisStatus>(["ready", "failed"]);
const CREATE_KEY_SLOT = "aurora:site-analysis:create-key";
const SELECTED_ANALYSIS_SLOT = "aurora:site-analysis:selected";
const retryKeySlot = (analysisId: number) => `aurora:site-analysis:retry-key:${analysisId}`;

function availableSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
const STAGE_LABELS: Record<string, string> = {
  queued: "В очереди",
  robots: "Проверка правил доступа",
  sitemap: "Чтение карты сайта",
  crawling: "Обход страниц",
  analyzing: "Поисковый аудит",
  extracting: "Извлечение доказательств",
  resolving_entities: "Связи и сущности",
  researching_external: "Внешние источники",
  answering: "OSINT-интервью",
  validating: "Проверка ответов",
  planning: "Маркетинговый план",
  saving: "Сохранение результата",
  ready: "Готово",
  failed: "Остановлено",
};

const PIPELINE_STAGES = [
  "Сбор основной информации",
  "Анализ страниц сайта",
  "Поиск социальных сетей и контактов",
  "SEO/GEO-анализ",
  "Формирование итогового отчёта",
] as const;

const PIPELINE_STAGE_INDEX: Record<string, number> = {
  queued: 0,
  robots: 0,
  sitemap: 0,
  crawling: 1,
  extracting: 2,
  resolving_entities: 2,
  researching_external: 2,
  analyzing: 3,
  answering: 3,
  validating: 3,
  planning: 4,
  saving: 4,
};

function pipelineStageIndex(analysis: Analysis) {
  if (analysis.status === "ready") return PIPELINE_STAGES.length;
  if (analysis.status === "failed") return -1;
  return PIPELINE_STAGE_INDEX[analysis.stage] ?? PIPELINE_STAGE_INDEX[analysis.status] ?? 0;
}

function analysisStatusTitle(analysis: Analysis) {
  if (analysis.status === "ready") return "Анализ готов";
  if (analysis.status === "failed") return "Анализ остановлен";
  if (analysis.status === "queued") return "Анализ поставлен в очередь";
  return "Проверяем сайт";
}

function confidenceLabel(value?: string) {
  if (value === "high") return "высокая";
  if (value === "medium") return "средняя";
  if (value === "low") return "предварительная";
  if (value === "none") return "нет подтверждения";
  return "не указана";
}

function priorityLabel(value?: string) {
  if (value === "P0") return "критичный приоритет";
  if (value === "P1") return "высокий приоритет";
  if (value === "P2") return "обычный приоритет";
  if (value === "high") return "высокий приоритет";
  if (value === "medium") return "средний приоритет";
  if (value === "low") return "низкий приоритет";
  return value || "";
}

function analysisVersionLabel(value?: string) {
  return value?.match(/\d+(?:\.\d+)*/u)?.[0] || "текущая";
}

function normalizedInputUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /^[a-z][a-z0-9+.-]*:/iu.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function inputDomain(value: string): string {
  try {
    return new URL(normalizedInputUrl(value)).hostname;
  } catch {
    return "";
  }
}

function withClientReceipt(analysis: Analysis): Analysis {
  return { ...analysis, clientReceivedAt: Date.now() };
}

function elapsedLabel(
  startedAt: string | null,
  endedAt: string | null,
  serverNow: string | null,
  clientReceivedAt: number | undefined,
  now: number,
) {
  if (!startedAt) return "—";
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return "—";
  const serverTimestamp = serverNow ? new Date(serverNow).getTime() : Number.NaN;
  const end = endedAt
    ? new Date(endedAt).getTime()
    : Number.isNaN(serverTimestamp) || !clientReceivedAt
      ? now
      : serverTimestamp + Math.max(0, now - clientReceivedAt);
  if (Number.isNaN(end)) return "—";
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60);
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours
    ? `${hours}:${pad(minutes % 60)}:${pad(seconds % 60)}`
    : `${pad(minutes)}:${pad(seconds % 60)}`;
}

function EvidenceLinks({ items }: { items?: Evidence[] }) {
  if (!items?.length) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-2" aria-label="Доказательства">
      {items.slice(0, 4).map((item, index) => (
        <li key={`${item.url}-${index}`}>
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-9 items-center gap-1.5 rounded-sm border border-line px-2.5 py-1.5 text-[12px] font-semibold text-brand hover:border-brand/35 hover:bg-info-soft"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            {item.label || "Открыть страницу"}
          </a>
        </li>
      ))}
    </ul>
  );
}

function FindingList({ title, items, empty }: { title: string; items?: Finding[]; empty: string }) {
  return (
    <section>
      <h3 className="text-[16px] font-extrabold text-text">{title}</h3>
      {!items?.length ? (
        <p className="mt-3 rounded-sm bg-success-soft p-3 text-[13px] text-success-text">{empty}</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {items.map((item, index) => (
            <li key={`${item.code || item.title}-${index}`} className="rounded-sm border border-line bg-surface-2 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-bold text-text">{item.title}</p>
                <Badge tone={item.severity === "high" ? "danger" : item.severity === "medium" ? "fire" : "neutral"}>
                  {item.severity === "high" ? "Высокий" : item.severity === "medium" ? "Средний" : "Низкий"}
                </Badge>
                {item.confidence && <span className="text-[11px] text-text-3">Точность: {confidenceLabel(item.confidence)}</span>}
              </div>
              {item.description && <p className="mt-1.5 text-[13px] leading-relaxed text-text-2">{item.description}</p>}
              <EvidenceLinks items={item.evidence} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const ANSWER_STATUS_COPY: Record<OsintStatus, { label: string; tone: "success" | "fire" | "danger" | "neutral" }> = {
  answered: { label: "Подтверждено", tone: "success" },
  hypothesis: { label: "Гипотеза", tone: "fire" },
  conflicting: { label: "Есть противоречия", tone: "danger" },
  insufficient_data: { label: "Недостаточно данных", tone: "neutral" },
};

function formattedEvidenceValue(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "Структурированное значение";
  }
}

function evidenceDate(value?: string | null) {
  if (!value) return "дата публикации не указана";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "дата публикации не указана"
    : new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function InterviewEvidence({
  ids,
  evidenceById,
  sourceById,
}: {
  ids: string[];
  evidenceById: Map<string, SnapshotEvidence>;
  sourceById: Map<string, SnapshotSource>;
}) {
  const items = ids.map((id) => evidenceById.get(id)).filter((item): item is SnapshotEvidence => Boolean(item));
  if (!items.length) return null;
  return (
    <ul className="mt-3 space-y-2" aria-label="Доказательства ответа">
      {items.map((item) => {
        const source = sourceById.get(item.sourceId);
        return (
          <li key={item.id} className="rounded-sm border border-line bg-surface-inset p-3">
            <p className="min-w-0 text-[12px] leading-relaxed [overflow-wrap:anywhere] text-text-2">{formattedEvidenceValue(item.value)}</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-3">
              <span>{source?.title || "Публичный источник"}</span>
              <span>{evidenceDate(item.publishedAt || source?.publishedAt)}</span>
              <span>проверено {evidenceDate(item.checkedAt || source?.checkedAt)}</span>
              {source?.url && (
                <a
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-6 items-center gap-1 font-semibold text-brand underline-offset-2 hover:underline"
                >
                  Открыть источник <ExternalLink className="h-3 w-3" aria-hidden />
                  <span className="sr-only"> в новой вкладке</span>
                </a>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

type InterviewFilter = "gaps" | "low" | "conflicts" | "experts" | "partners" | "external";

function OsintInterview({ report, snapshot }: { report: OsintReport; snapshot?: EvidenceSnapshot }) {
  const [category, setCategory] = useState("all");
  const [filters, setFilters] = useState<Set<InterviewFilter>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const questions = useMemo(() => new Map(SITE_INTERVIEW_QUESTIONS.map((question) => [question.id, question])), []);
  const evidenceById = useMemo(() => new Map((snapshot?.evidence || []).map((item) => [item.id, item])), [snapshot?.evidence]);
  const sourceById = useMemo(() => new Map((snapshot?.sources || []).map((item) => [item.id, item])), [snapshot?.sources]);
  const visible = useMemo(() => report.answers.filter((answer) => {
    const question = questions.get(answer.questionId);
    if (category !== "all" && question?.category !== category) return false;
    for (const filter of filters) {
      if (filter === "gaps" && !answer.gaps.length && !answer.requiredIntegrations.length) return false;
      if (filter === "low" && !["low", "none"].includes(answer.confidence)) return false;
      if (filter === "conflicts" && answer.status !== "conflicting") return false;
      if (filter === "experts" && !["experts", "expert_activity"].includes(question?.category || "")) return false;
      if (filter === "partners" && question?.category !== "partners") return false;
      if (filter === "external") {
        const hasExternal = answer.evidenceIds.some((id) => {
          const evidence = evidenceById.get(id);
          const source = evidence ? sourceById.get(evidence.sourceId) : null;
          return Boolean(source && !["owned_page", "owned_document", "structured_data"].includes(source.kind));
        });
        if (!hasExternal) return false;
      }
    }
    return true;
  }), [category, evidenceById, filters, questions, report.answers, sourceById]);

  const toggleFilter = (value: InterviewFilter) => {
    setFilters((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };
  const toggleAnswer = (questionId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(questionId)) next.delete(questionId);
      else next.add(questionId);
      return next;
    });
  };

  const stats = [
    ["Подтверждено", report.summary.answered, "text-success-text"],
    ["Гипотезы", report.summary.hypothesis, "text-fire-text"],
    ["Противоречия", report.summary.conflicting, "text-danger-text"],
    ["Недостаточно данных", report.summary.insufficientData, "text-text-2"],
  ] as const;
  const filterOptions: Array<[InterviewFilter, string]> = [
    ["gaps", "Только пробелы"],
    ["low", "Низкая уверенность"],
    ["conflicts", "Противоречия"],
    ["experts", "Эксперты"],
    ["partners", "Партнёры"],
    ["external", "Внешние источники"],
  ];

  return (
    <section aria-labelledby="osint-interview-title" className="space-y-5">
      <div className="rounded-sm border border-brand/20 bg-info-soft p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wide text-brand">Доказательное OSINT-интервью</p>
            <h3 id="osint-interview-title" className="mt-1 text-[19px] font-black text-text">Ответы по всей модели организации</h3>
            <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-text-2">
              Каждый вопрос имеет terminal-статус. Отсутствие сведений показано как пробел, а не как отрицательный факт.
            </p>
          </div>
          <Badge tone="brand">{report.summary.total} вопросов</Badge>
        </div>
        <dl className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {stats.map(([label, value, color]) => (
            <div key={label} className="rounded-sm bg-surface/80 p-3">
              <dt className="text-[11px] text-text-3">{label}</dt>
              <dd className={cn("nums mt-1 text-xl font-black", color)}>{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-[11px] text-text-3">
          Покрытие: {report.coverage?.mode === "external" ? "сайт и разрешённые внешние источники" : "только подтверждённый домен"}
          {report.snapshotHash ? ` · ${report.snapshotHash.slice(0, 20)}…` : ""}
        </p>
      </div>

      <div className="rounded-sm border border-line bg-surface-2 p-4">
        <label htmlFor="interview-category" className="block text-[12px] font-bold text-text">Раздел интервью</label>
        <select
          id="interview-category"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          className="mt-1.5 min-h-11 w-full rounded-sm border border-line bg-surface px-3 text-[13px] text-text sm:max-w-xl"
        >
          <option value="all">Все разделы</option>
          {SITE_INTERVIEW_CATEGORIES.map((item) => <option key={item.id} value={item.id}>{item.order}. {item.title}</option>)}
        </select>
        <div className="mt-3 flex flex-wrap gap-2" aria-label="Фильтры ответов">
          {filterOptions.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filters.has(value)}
              onClick={() => toggleFilter(value)}
              className={cn(
                "min-h-10 rounded-full border px-3 py-2 text-[12px] font-semibold",
                "motion-safe:transition-colors",
                filters.has(value) ? "border-brand bg-info-soft text-brand" : "border-line bg-surface text-text-2 hover:border-brand/35",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <p role="status" className="mt-3 text-[12px] text-text-3">Показано ответов: {visible.length} из {report.answers.length}</p>
      </div>

      {visible.length ? (
        <div className="space-y-3">
          {visible.map((answer) => {
            const question = questions.get(answer.questionId);
            const isExpanded = expanded.has(answer.questionId);
            const detailsId = `osint-answer-${answer.questionId.replace(/[^a-z0-9_-]/giu, "-")}`;
            const status = ANSWER_STATUS_COPY[answer.status];
            return (
              <article key={answer.questionId} className="rounded-sm border border-line bg-surface-2 p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-bold uppercase tracking-wide text-text-3">{question?.title || answer.questionId}</p>
                    <h4 className="mt-1 text-[15px] font-extrabold leading-snug text-text">{question?.question || answer.questionId}</h4>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={status.tone}>{status.label}</Badge>
                    <span className="text-[11px] text-text-3">Точность: {confidenceLabel(answer.confidence)}</span>
                  </div>
                </div>
                <p className="mt-3 text-[14px] font-semibold leading-relaxed text-text">{answer.shortAnswer}</p>
                <p className={cn("mt-2 text-[13px] leading-relaxed text-text-2", !isExpanded && "line-clamp-3")}>{answer.explanation}</p>
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  aria-controls={detailsId}
                  onClick={() => toggleAnswer(answer.questionId)}
                  className="mt-3 inline-flex min-h-10 items-center gap-1.5 rounded-sm px-2 text-[12px] font-bold text-brand hover:bg-info-soft"
                >
                  <ChevronDown className={cn("h-4 w-4 motion-safe:transition-transform", isExpanded && "rotate-180")} aria-hidden />
                  {isExpanded ? "Свернуть доказательства" : "Развернуть доказательства"}
                </button>
                {isExpanded && (
                  <div id={detailsId} className="mt-3 space-y-4 border-t border-line pt-4">
                    {answer.facts.length > 0 && (
                      <section>
                        <h5 className="text-[12px] font-extrabold text-text">Подтверждённые факты</h5>
                        <ul className="mt-2 space-y-3">
                          {answer.facts.map((fact, index) => (
                            <li key={`${answer.questionId}-fact-${index}`} className="text-[13px] leading-relaxed text-text-2">
                              {fact.statement}
                              <InterviewEvidence ids={fact.evidenceIds} evidenceById={evidenceById} sourceById={sourceById} />
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}
                    {answer.evidenceIds.length > 0 && answer.facts.length === 0 && (
                      <InterviewEvidence ids={answer.evidenceIds} evidenceById={evidenceById} sourceById={sourceById} />
                    )}
                    {answer.contradictions.length > 0 && (
                      <section className="rounded-sm border border-danger/25 bg-danger-soft p-3">
                        <h5 className="text-[12px] font-extrabold text-danger-text">Противоречия</h5>
                        {answer.contradictions.map((item, index) => (
                          <div key={`${answer.questionId}-conflict-${index}`} className="mt-2 text-[13px] text-text-2">
                            <p>{item.description}</p>
                            <InterviewEvidence ids={item.evidenceIds} evidenceById={evidenceById} sourceById={sourceById} />
                          </div>
                        ))}
                      </section>
                    )}
                    {(answer.gaps.length > 0 || answer.requiredIntegrations.length > 0) && (
                      <section className="rounded-sm bg-surface-inset p-3">
                        <h5 className="text-[12px] font-extrabold text-text">Чего не хватает</h5>
                        <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] text-text-2">
                          {answer.gaps.map((gap) => <li key={gap}>{gap}</li>)}
                          {answer.requiredIntegrations.map((integration) => <li key={integration}>Интеграция: {integration}</li>)}
                        </ul>
                      </section>
                    )}
                    {answer.recommendationHooks.length > 0 && (
                      <section>
                        <h5 className="text-[12px] font-extrabold text-text">Влияние на продвижение</h5>
                        <ul className="mt-2 space-y-2 text-[13px] text-text-2">
                          {answer.recommendationHooks.map((hook, index) => <li key={`${hook.kind}-${index}`}><b className="text-text">{hook.kind}:</b> {hook.rationale}</li>)}
                        </ul>
                      </section>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <p className="rounded-sm border border-dashed border-line p-6 text-center text-[13px] text-text-3">По выбранным фильтрам ответов нет.</p>
      )}

      <section aria-labelledby="evidence-plan-title" className="rounded-sm border border-line bg-surface-2 p-4 sm:p-5">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h4 id="evidence-plan-title" className="text-[16px] font-extrabold text-text">План, выведенный из интервью</h4>
            <p className="mt-1 text-[12px] text-text-3">В план попадают только hooks из валидных ответов с существующими доказательствами.</p>
          </div>
          <Badge tone="brand">{report.marketingPlan?.publicationBacklog?.length || 0} действий</Badge>
        </div>
        {report.marketingPlan?.publicationBacklog?.length ? (
          <ol className="mt-3 grid gap-3 lg:grid-cols-2">
            {report.marketingPlan.publicationBacklog.map((item) => (
              <li key={item.key} className="rounded-sm bg-surface-inset p-3">
                <div className="flex items-center gap-2">
                  <Badge tone={item.priority === "P0" ? "success" : item.priority === "P1" ? "brand" : "neutral"}>{item.priority}</Badge>
                  <span className="text-[11px] text-text-3">Точность: {confidenceLabel(item.confidence)}</span>
                </div>
                <p className="mt-2 text-[12px] font-bold text-text">{item.kind}</p>
                <p className="mt-1 text-[13px] leading-relaxed text-text-2">{item.rationale}</p>
                <InterviewEvidence ids={item.evidenceIds} evidenceById={evidenceById} sourceById={sourceById} />
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-3 rounded-sm bg-surface-inset p-3 text-[13px] text-text-3">Подтверждённых действий пока нет: сначала нужно закрыть показанные пробелы в данных.</p>
        )}
        <h5 className="mt-5 text-[12px] font-extrabold text-text">Показатели, требующие интеграций</h5>
        <ul className="mt-2 grid gap-2 text-[12px] text-text-2 sm:grid-cols-2">
          {(report.marketingPlan?.measurement || []).map((item) => (
            <li key={item.kpi} className="rounded-sm border border-line p-3"><b className="text-text">{item.kpi}:</b> {item.requiredIntegration}</li>
          ))}
        </ul>
      </section>
    </section>
  );
}

function ReportView({ report, analysisId }: { report: SiteReport; analysisId: number }) {
  const tasks = [
    ...(report.marketingPlan?.seoTasks || []),
    ...(report.marketingPlan?.geoTasks || []),
    ...(report.marketingPlan?.publicationBacklog || []),
  ];
  return (
    <div className="space-y-6">
      {report.osint && <OsintInterview report={report.osint} snapshot={report.snapshot} />}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-sm bg-surface-inset p-4">
          <p className="text-[12px] text-text-3">Страниц в срезе</p>
          <p className="nums mt-1 text-2xl font-black text-text">{report.inventory?.length || 0}</p>
        </div>
        <div className="rounded-sm bg-surface-inset p-4">
          <p className="text-[12px] text-text-3">Внутренних ссылок</p>
          <p className="nums mt-1 text-2xl font-black text-text">{report.internalLinking?.totalLinks || 0}</p>
        </div>
        <div className="rounded-sm bg-surface-inset p-4">
          <p className="text-[12px] text-text-3">Версия анализа</p>
          <p className="mt-1 truncate text-[13px] font-bold text-text">{analysisVersionLabel(report.policyVersion)}</p>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <FindingList title="Технический поисковый аудит" items={report.seoAudit} empty="Критичных поисковых проблем в проверенном срезе не найдено." />
        <FindingList title="Аудит для поиска с ИИ" items={report.geoAudit} empty="Критичных проблем для поиска с ИИ в проверенном срезе не найдено." />
      </div>

      <section>
        <h3 className="text-[16px] font-extrabold text-text">Темы и интенты</h3>
        <div className="mt-3 flex flex-wrap gap-2">
          {(report.themes || []).map((theme) => (
            <span key={theme.theme} className="rounded-full border border-line bg-surface-2 px-3 py-1.5 text-[12px] font-semibold text-text-2">
              {theme.theme} · {theme.occurrences}
            </span>
          ))}
          {(report.intents || []).map((intent) => (
            <span key={intent.id} className="rounded-full bg-info-soft px-3 py-1.5 text-[12px] font-semibold text-info-text">
              {intent.label}: {intent.pages}
            </span>
          ))}
        </div>
      </section>

      <section>
        <h3 className="text-[16px] font-extrabold text-text">Основа маркетингового плана</h3>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {(report.marketingPlan?.goals || []).map((goal, index) => (
            <article key={`${goal.title}-${index}`} className="rounded-sm border border-line bg-surface-2 p-4">
              <p className="text-[11px] font-bold uppercase tracking-wide text-brand">Цель</p>
              <p className="mt-1 font-bold text-text">{goal.title}</p>
              {goal.kpi && <p className="mt-1 text-[13px] text-text-2">Показатель: {goal.kpi}</p>}
              {goal.target && <p className="mt-1 text-[13px] text-text-2">Ориентир: {goal.target}</p>}
              <p className="mt-2 text-[11px] text-text-3">Точность: {confidenceLabel(goal.confidence)}</p>
              <EvidenceLinks items={goal.sources} />
            </article>
          ))}
          {report.marketingPlan?.icp && (
            <article className="rounded-sm border border-line bg-surface-2 p-4">
              <p className="text-[11px] font-bold uppercase tracking-wide text-brand">Гипотеза о целевой аудитории</p>
              <p className="mt-1 text-[13px] leading-relaxed text-text-2">{report.marketingPlan.icp.description}</p>
              <p className="mt-2 text-[11px] text-text-3">Точность: {confidenceLabel(report.marketingPlan.icp.confidence)}</p>
              <EvidenceLinks items={report.marketingPlan.icp.sources} />
            </article>
          )}
          {report.marketingPlan?.positioning && (
            <article className="rounded-sm border border-line bg-surface-2 p-4">
              <p className="text-[11px] font-bold uppercase tracking-wide text-brand">Позиционирование</p>
              <p className="mt-1 text-[13px] leading-relaxed text-text-2">{report.marketingPlan.positioning.statement}</p>
              <p className="mt-2 text-[11px] text-text-3">Точность: {confidenceLabel(report.marketingPlan.positioning.confidence)}</p>
              <EvidenceLinks items={report.marketingPlan.positioning.sources} />
            </article>
          )}
        </div>
      </section>

      <section>
        <h3 className="text-[16px] font-extrabold text-text">Воронка и каналы продвижения</h3>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {(report.marketingPlan?.funnel || []).map((step, index) => (
            <article key={`${step.stage}-${index}`} className="rounded-sm border border-line bg-surface-2 p-4">
              <p className="font-bold text-text">{step.stage}</p>
              <p className="mt-1 text-[13px] leading-relaxed text-text-2">{step.action}</p>
              <p className="mt-2 text-[11px] text-text-3">Точность: {confidenceLabel(step.confidence)}</p>
              <EvidenceLinks items={step.sources} />
            </article>
          ))}
          {(report.marketingPlan?.promotionChannels || []).map((channel, index) => (
            <article key={`${channel.channel}-${index}`} className="rounded-sm border border-line bg-surface-2 p-4">
              <p className="font-bold text-text">{channel.channel}</p>
              <p className="mt-1 text-[13px] leading-relaxed text-text-2">{channel.reason}</p>
              <p className="mt-2 text-[11px] text-text-3">Точность: {confidenceLabel(channel.confidence)}</p>
              <EvidenceLinks items={channel.sources} />
            </article>
          ))}
        </div>
      </section>

      <section>
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 className="text-[16px] font-extrabold text-text">Приоритетные задачи</h3>
            <p className="mt-1 text-[13px] text-text-3">Каждый пункт содержит источник и уровень уверенности.</p>
          </div>
          <Badge tone="brand">{tasks.length} задач</Badge>
        </div>
        <ol className="mt-3 grid gap-3 lg:grid-cols-2">
          {tasks.slice(0, 16).map((task, index) => (
            <li key={`${task.title || task.action}-${index}`} className="rounded-sm border border-line bg-surface-2 p-4">
              <div className="flex gap-3">
                <span className="nums grid h-7 w-7 shrink-0 place-items-center rounded-full bg-info-soft text-[12px] font-black text-brand">{index + 1}</span>
                <div className="min-w-0">
                  <p className="font-bold text-text">{task.title || task.action}</p>
                  {task.rationale && <p className="mt-1 text-[13px] leading-relaxed text-text-2">{task.rationale}</p>}
                  <p className="mt-2 text-[11px] text-text-3">
                    {task.priority ? `${priorityLabel(task.priority)} · ` : ""}{task.dueDays ? `до ${task.dueDays} дней · ` : ""}точность: {confidenceLabel(task.confidence)}
                  </p>
                  <EvidenceLinks items={task.sources} />
                </div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="rounded-sm border border-line bg-surface-inset p-4">
        <h3 className="text-[14px] font-extrabold text-text">Какие данные нужны для реальных показателей</h3>
        <ul className="mt-2 space-y-2 text-[13px] text-text-2">
          {(report.marketingPlan?.measurement || []).map((row) => (
            <li key={row.kpi}><b className="text-text">{row.kpi}:</b> {row.sourceNeeded}</li>
          ))}
        </ul>
      </section>

      <section className="rounded-sm border border-fire/25 bg-fire-soft p-4">
        <h3 className="flex items-center gap-2 text-[14px] font-extrabold text-text">
          <AlertTriangle className="h-4 w-4" aria-hidden /> Ограничения анализа открытых страниц
        </h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-text-2">
          {(report.limitations || []).map((item) => <li key={item}>{item}</li>)}
        </ul>
      </section>

      {report.osint && (
        <section className="rounded-sm border border-line bg-surface-2 p-4">
          <h3 className="text-[14px] font-extrabold text-text">Экспорт неизменяемого среза</h3>
          <p className="mt-1 text-[12px] text-text-3">Все форматы строятся из одного сохранённого snapshot с версиями, ответами, доказательствами и ссылками.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {[
              ["csv", "CSV"], ["xlsx", "XLSX"], ["json", "JSON"],
              ["pdf", "PDF"], ["html", "HTML"], ["markdown", "Markdown"],
            ].map(([format, label]) => (
              <a
                key={format}
                href={`/api/site-analysis/${analysisId}/export?format=${format}`}
                download
                className="inline-flex min-h-10 items-center rounded-sm border border-line px-3 py-2 text-[12px] font-bold text-brand hover:border-brand/35 hover:bg-info-soft"
              >
                {label}
              </a>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export default function SiteAnalysisPage() {
  const [url, setUrl] = useState("");
  const [domain, setDomain] = useState("");
  const [domainEdited, setDomainEdited] = useState(false);
  const [consent, setConsent] = useState(false);
  const [analyses, setAnalyses] = useState<Analysis[]>([]);
  const [current, setCurrent] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [pageError, setPageError] = useState<{ message: string; requestId?: string } | null>(null);
  const [comparison, setComparison] = useState<RunComparison | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const requestSequence = useRef(0);
  const createKeyRef = useRef<StableSiteAnalysisKey | null>(null);
  const retryKeyRef = useRef<StableSiteAnalysisKey | null>(null);

  const loadList = useCallback(async () => {
    try {
      const response = await fetch("/api/site-analysis", { cache: "no-store" });
      const body = await response.json() as { analyses?: Analysis[]; requestId?: string; error?: string };
      if (!response.ok) throw Object.assign(new Error("list_failed"), { requestId: body.requestId });
      setAnalyses((body.analyses || []).map(withClientReceipt));
    } catch (error) {
      setPageError({ message: "Не удалось загрузить историю анализов.", requestId: (error as { requestId?: string }).requestId });
    } finally {
      setLoading(false);
    }
  }, []);

  const loadOne = useCallback(async (id: number) => {
    const sequence = ++requestSequence.current;
    try {
      const response = await fetch(`/api/site-analysis/${id}`, { cache: "no-store" });
      const body = await response.json() as { analysis?: Analysis; requestId?: string; error?: string };
      if (!response.ok || !body.analysis) throw Object.assign(new Error(body.error || "poll_failed"), { requestId: body.requestId });
      if (sequence !== requestSequence.current) return null;
      body.analysis = withClientReceipt(body.analysis);
      setComparison(null);
      setCurrent(body.analysis);
      availableSessionStorage()?.setItem(SELECTED_ANALYSIS_SLOT, String(body.analysis.id));
      setAnalyses((items) => [body.analysis!, ...items.filter((item) => item.id !== body.analysis!.id)]);
      if (TERMINAL.has(body.analysis.status)) {
        const storage = availableSessionStorage();
        releaseStableSiteAnalysisKey(storage, CREATE_KEY_SLOT, body.analysis.id);
        releaseStableSiteAnalysisKey(storage, retryKeySlot(body.analysis.id), body.analysis.id);
        if (createKeyRef.current?.analysisId === body.analysis.id) createKeyRef.current = null;
        if (retryKeyRef.current?.analysisId === body.analysis.id) retryKeyRef.current = null;
      }
      setPageError(null);
      return body.analysis;
    } catch (error) {
      if (sequence === requestSequence.current) {
        setPageError({ message: "Не удалось обновить статус анализа.", requestId: (error as { requestId?: string }).requestId });
      }
      return null;
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- state changes only after the request settles
  useEffect(() => { void loadList(); }, [loadList]);

  useEffect(() => {
    if (loading || current || !analyses.length) return;
    const selected = Number(availableSessionStorage()?.getItem(SELECTED_ANALYSIS_SLOT));
    const initial = analyses.find((analysis) => analysis.id === selected) || analyses[0];
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loadOne updates only after the detail request settles
    void loadOne(initial.id);
  }, [analyses, current, loadOne, loading]);

  useEffect(() => {
    if (!current || current.status !== "ready") return;
    let cancelled = false;
    void fetch(`/api/site-analysis/${current.id}/compare`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { comparison?: RunComparison };
        if (!cancelled && response.ok) setComparison(body.comparison || null);
      })
      .catch(() => { if (!cancelled) setComparison(null); });
    return () => { cancelled = true; };
  }, [current]);

  useEffect(() => {
    if (!current || TERMINAL.has(current.status)) return;
    const timer = window.setInterval(() => void loadOne(current.id), 2_000);
    return () => window.clearInterval(timer);
  }, [current, loadOne]);

  useEffect(() => {
    if (!current || TERMINAL.has(current.status)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [current]);

  const canSubmit = Boolean(url.trim() && domain.trim() && consent && !submitting);
  const elapsed = useMemo(
    () => elapsedLabel(
      current?.startedAt || current?.createdAt || null,
      current?.completedAt || null,
      current?.serverNow || null,
      current?.clientReceivedAt,
      now,
    ),
    [current?.startedAt, current?.createdAt, current?.completedAt, current?.serverNow, current?.clientReceivedAt, now],
  );
  const liveStatus = current
    ? `${analysisStatusTitle(current)}. Текущий этап: ${current.detail || STAGE_LABELS[current.stage] || current.stage}.`
    : loading ? "Загружаем историю анализов" : "";

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setPageError(null);
    try {
      const fingerprint = siteAnalysisIntentFingerprint(normalizedInputUrl(url), domain);
      const keyRecord = acquireStableSiteAnalysisKey(
        availableSessionStorage(),
        CREATE_KEY_SLOT,
        fingerprint,
        "site-analysis",
        () => crypto.randomUUID(),
        createKeyRef.current,
      );
      createKeyRef.current = keyRecord;
      const response = await fetch("/api/site-analysis", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": keyRecord.key },
        body: JSON.stringify({ url: normalizedInputUrl(url), confirmedDomain: domain.trim(), consent: true }),
      });
      const body = await response.json() as { analysis?: Analysis; requestId?: string; error?: string };
      if (body.analysis) body.analysis = withClientReceipt(body.analysis);
      if (body.analysis) {
        createKeyRef.current = bindStableSiteAnalysisKey(
          availableSessionStorage(),
          CREATE_KEY_SLOT,
          keyRecord,
          body.analysis.id,
        );
        setCurrent(body.analysis);
        setAnalyses((items) => [body.analysis!, ...items.filter((item) => item.id !== body.analysis!.id)]);
        if (TERMINAL.has(body.analysis.status)) {
          releaseStableSiteAnalysisKey(availableSessionStorage(), CREATE_KEY_SLOT, body.analysis.id);
          createKeyRef.current = null;
        }
      }
      if (!response.ok || !body.analysis) {
        const message = body.error === "worker_unavailable"
          ? "Полный фоновый worker сейчас недоступен. Запусти приложение через npm run dev."
          : siteAnalysisErrorMessage(body.error || "unavailable");
        throw Object.assign(new Error(message), { requestId: body.requestId });
      }
      setCurrent(body.analysis);
      setAnalyses((items) => [body.analysis!, ...items.filter((item) => item.id !== body.analysis!.id)]);
      // Первый poll выполняется сразу после подтверждённого создания, до интервального таймера.
      await loadOne(body.analysis.id);
    } catch (error) {
      setPageError({ message: error instanceof Error ? error.message : "Не удалось запустить анализ.", requestId: (error as { requestId?: string }).requestId });
    } finally {
      setSubmitting(false);
    }
  };

  const retry = async () => {
    if (!current || submitting) return;
    setSubmitting(true);
    setPageError(null);
    try {
      const slot = retryKeySlot(current.id);
      const keyRecord = acquireStableSiteAnalysisKey(
        availableSessionStorage(),
        slot,
        `${current.id}:r${current.runRevision}`,
        "site-analysis-retry",
        () => crypto.randomUUID(),
        retryKeyRef.current,
      );
      retryKeyRef.current = keyRecord;
      const response = await fetch(`/api/site-analysis/${current.id}/retry`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": keyRecord.key },
        body: JSON.stringify({ clientKey: keyRecord.key }),
      });
      const body = await response.json() as { analysis?: Analysis; requestId?: string; error?: string };
      if (body.analysis) body.analysis = withClientReceipt(body.analysis);
      if (body.analysis) {
        retryKeyRef.current = bindStableSiteAnalysisKey(
          availableSessionStorage(),
          slot,
          keyRecord,
          body.analysis.id,
        );
        setCurrent(body.analysis);
        if (TERMINAL.has(body.analysis.status)) {
          releaseStableSiteAnalysisKey(availableSessionStorage(), slot, body.analysis.id);
          retryKeyRef.current = null;
        }
      }
      if (!response.ok || !body.analysis) throw Object.assign(new Error(siteAnalysisErrorMessage(body.error || "unavailable")), { requestId: body.requestId });
      setCurrent(body.analysis);
      await loadOne(body.analysis.id);
    } catch (error) {
      setPageError({ message: error instanceof Error ? error.message : "Не удалось повторить анализ.", requestId: (error as { requestId?: string }).requestId });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppShell
      title="Анализ сайта"
      subtitle="Безопасный анализ открытых страниц, технический поисковый аудит и доказательный маркетинговый план."
    >
      <div role="status" className="sr-only">{liveStatus}</div>
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          <Card className="overflow-hidden">
            <div className="border-b border-line px-5 py-5 sm:px-7">
              <div className="flex items-start gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-sm bg-info-soft text-brand">
                  <SearchCode className="h-5 w-5" aria-hidden />
                </span>
                <div>
                  <h2 className="text-[18px] font-black text-text">Новый анализ</h2>
                  <p className="mt-1 text-[13px] leading-relaxed text-text-2">
                    Проверяем только открытые страницы подтверждённого домена, соблюдаем правила доступа сайта и не входим в закрытые кабинеты.
                  </p>
                </div>
              </div>
            </div>
            <form onSubmit={submit} className="space-y-4 px-5 py-5 sm:px-7 sm:py-6">
              <label className="block">
                <span className="mb-1.5 block text-[13px] font-bold text-text">Адрес сайта</span>
                <Input
                  type="url"
                  inputMode="url"
                  autoComplete="url"
                  value={url}
                  placeholder="https://example.com"
                  onChange={(event) => {
                    const next = event.target.value;
                    setUrl(next);
                    if (!domainEdited) setDomain(inputDomain(next));
                  }}
                  onBlur={() => { if (!domain) setDomain(inputDomain(url)); }}
                  required
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[13px] font-bold text-text">Подтверждённый домен</span>
                <Input
                  value={domain}
                  placeholder="example.com"
                  autoComplete="off"
                  onChange={(event) => { setDomain(event.target.value); setDomainEdited(true); }}
                  required
                />
                <span className="mt-1.5 block text-[12px] text-text-3">Должен точно совпадать с доменом указанного адреса.</span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-sm border border-line bg-surface-2 p-4">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                  required
                  className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--brand)]"
                />
                <span className="text-[13px] leading-relaxed text-text-2">
                  Я подтверждаю право анализировать публичные страницы этого домена. Аврора не будет обходить авторизацию, подписку или ограничения сайта.
                </span>
              </label>
              <Button type="submit" variant="primary" loading={submitting} disabled={submitting}>
                <FileSearch className="h-4 w-4" aria-hidden />
                Запустить фоновый анализ
              </Button>
            </form>
          </Card>

          {pageError && (
            <div role="alert" className="rounded-sm border border-danger/30 bg-danger-soft p-4 text-[13px] text-text">
              <p className="font-bold">{pageError.message}</p>
              {pageError.requestId && <p className="nums mt-1 text-[12px] text-text-3">Номер запроса: {pageError.requestId}</p>}
            </div>
          )}

          {current && (
            <Card
              className="overflow-hidden"
              aria-busy={!TERMINAL.has(current.status)}
              aria-labelledby="analysis-status-title"
            >
              <div className="border-b border-line px-5 py-5 sm:px-7">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h2 id="analysis-status-title" className="text-[18px] font-black text-text">
                      {analysisStatusTitle(current)}
                    </h2>
                    <p className="mt-1 truncate text-[13px] text-text-2">{current.targetUrl}</p>
                    <p className="nums mt-1 text-[11px] text-text-3">Номер запроса: {current.requestId}</p>
                  </div>
                  <Badge tone={current.status === "ready" ? "success" : current.status === "failed" ? "danger" : "brand"}>
                    {STAGE_LABELS[current.stage] || current.stage}
                  </Badge>
                </div>
                <dl className="mt-4 grid gap-3 rounded-sm border border-line bg-surface-2 p-4 sm:grid-cols-[180px_minmax(0,1fr)]">
                  <div>
                    <dt className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-text-3">
                      <Clock3 className="h-3.5 w-3.5" aria-hidden /> Прошло времени
                    </dt>
                    <dd className="nums mt-1 text-[18px] font-black tabular-nums text-text">{elapsed}</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-bold uppercase tracking-wide text-text-3">Текущий этап</dt>
                    <dd className="mt-1 text-[13px] font-bold leading-relaxed text-text">
                      {current.detail || STAGE_LABELS[current.stage] || current.stage}
                    </dd>
                  </div>
                </dl>
                {current.status !== "failed" && (
                  <ol className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5" aria-label="Этапы проверки сайта">
                    {PIPELINE_STAGES.map((label, index) => {
                      const currentIndex = pipelineStageIndex(current);
                      const complete = current.status === "ready" || index < currentIndex;
                      const active = current.status !== "ready" && index === currentIndex;
                      return (
                        <li
                          key={label}
                          aria-current={active ? "step" : undefined}
                          className={cn(
                            "flex min-h-14 items-center gap-2 rounded-sm border px-3 py-2 sm:min-h-24 sm:flex-col sm:items-start",
                            complete && "border-success/30 bg-success-soft",
                            active && "border-brand/35 bg-info-soft",
                            !complete && !active && "border-line bg-surface-2",
                          )}
                        >
                          <span className={cn(
                            "grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-black",
                            complete && "bg-success text-white",
                            active && "bg-brand text-white",
                            !complete && !active && "border border-line bg-surface text-text-3",
                          )}>
                            {complete ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : index + 1}
                          </span>
                          <span className={cn(
                            "text-[11px] font-bold leading-snug",
                            (complete || active) ? "text-text" : "text-text-3",
                          )}>{label}</span>
                        </li>
                      );
                    })}
                  </ol>
                )}
                {current.status === "failed" && (
                  <div className="mt-4 flex flex-wrap items-center gap-3 rounded-sm bg-danger-soft p-4">
                    <AlertTriangle className="h-5 w-5 shrink-0 text-danger-text" aria-hidden />
                    <p className="min-w-0 flex-1 text-[13px] text-text">{current.error?.message || "Анализ остановлен."}</p>
                    <Button type="button" variant="outline" size="sm" loading={submitting} onClick={() => void retry()}>
                      <RefreshCw className="h-4 w-4" aria-hidden /> Повторить
                    </Button>
                  </div>
                )}
              </div>
              <div className="px-5 py-6 sm:px-7">
                {current.status === "ready" && current.result ? (
                  <div className="space-y-5">
                    {comparison?.previousRevision && (
                      <section className="rounded-sm border border-line bg-surface-inset p-4" aria-labelledby="run-comparison-title">
                        <h3 id="run-comparison-title" className="text-[14px] font-extrabold text-text">Изменения относительно ревизии {comparison.previousRevision}</h3>
                        <dl className="mt-3 grid grid-cols-2 gap-2 text-[12px] sm:grid-cols-4">
                          <div><dt className="text-text-3">Новые</dt><dd className="nums mt-0.5 font-black text-text">{comparison.new.length}</dd></div>
                          <div><dt className="text-text-3">Изменились</dt><dd className="nums mt-0.5 font-black text-text">{comparison.changed.length}</dd></div>
                          <div><dt className="text-text-3">Исчезли</dt><dd className="nums mt-0.5 font-black text-text">{comparison.disappeared.length}</dd></div>
                          <div><dt className="text-text-3">Без изменений</dt><dd className="nums mt-0.5 font-black text-text">{comparison.unchanged}</dd></div>
                        </dl>
                      </section>
                    )}
                    <ReportView report={current.result} analysisId={current.id} />
                  </div>
                ) : current.status !== "failed" ? (
                  <div className="grid gap-3 sm:grid-cols-2" aria-hidden>
                    {[0, 1, 2, 3].map((item) => <div key={item} className="skeleton h-28 rounded-sm motion-reduce:animate-none" />)}
                  </div>
                ) : null}
              </div>
            </Card>
          )}
        </div>

        <aside className="space-y-4 xl:sticky xl:top-6">
          <Card className="p-5">
            <h2 className="flex items-center gap-2 text-[15px] font-extrabold text-text">
              <ShieldCheck className="h-5 w-5 text-success-text" aria-hidden /> Границы анализа
            </h2>
            <ul className="mt-3 space-y-2 text-[12px] leading-relaxed text-text-2">
              <li>До 20 страниц, 5 МБ на страницу и 50 МБ на один запуск.</li>
              <li>Только стандартные веб-порты и публичные сетевые адреса.</li>
              <li>Адрес домена закрепляется на соединение; каждое перенаправление проверяется заново.</li>
              <li>Трафик и конверсии появятся только после отдельной интеграции аналитики.</li>
            </ul>
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b border-line px-5 py-4">
              <h2 className="flex items-center gap-2 text-[15px] font-extrabold text-text">
                <Globe2 className="h-4 w-4 text-brand" aria-hidden /> История
              </h2>
            </div>
            {loading ? (
              <div className="space-y-2 p-4" role="status"><span className="sr-only">Загружаем историю</span>{[0, 1, 2].map((item) => <div key={item} className="skeleton h-16 rounded-sm" />)}</div>
            ) : analyses.length ? (
              <ul className="divide-y divide-line">
                {analyses.map((analysis) => (
                  <li key={analysis.id}>
                    <button
                      type="button"
                      onClick={() => void loadOne(analysis.id)}
                      aria-current={current?.id === analysis.id ? "true" : undefined}
                      className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2"
                    >
                      {analysis.status === "ready" ? <CheckCircle2 className="h-4 w-4 shrink-0 text-success-text" aria-hidden /> : analysis.status === "failed" ? <AlertTriangle className="h-4 w-4 shrink-0 text-danger-text" aria-hidden /> : <Sparkles className="h-4 w-4 shrink-0 text-brand" aria-hidden />}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12px] font-bold text-text">{analysis.confirmedDomain}</span>
                        <span className="mt-0.5 block text-[11px] text-text-3">{STAGE_LABELS[analysis.stage] || analysis.stage}</span>
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-text-3" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-5 text-[13px] leading-relaxed text-text-3">Запуски появятся здесь и переживут перезагрузку страницы.</p>
            )}
          </Card>

          <div className="flex items-start gap-2 rounded-sm bg-info-soft p-4 text-[12px] leading-relaxed text-info-text">
            <Link2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            Каждый вывод в готовом отчёте связан с публичной страницей-доказательством.
          </div>
        </aside>
      </div>
    </AppShell>
  );
}
