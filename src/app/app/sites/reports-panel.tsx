"use client";

import { useState } from "react";
import { ArrowRight, Check, Download, ExternalLink, FileText, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/primitives";
import { projectUrl } from "@/lib/project-transport";
import { cn } from "@/lib/utils";

import { formatDate } from "./client";
import { InterpretationBlock } from "./interpretation-block";
import { REPORT_KIND_LABEL, plural, type ProfileView, type ReportView, type SiteTab } from "./types";

type Props = {
  siteId: number;
  profile: ProfileView | null;
  reports: ReportView[];
  reportRequested: boolean;
  retryingAi: string | null;
  onRequestReport: () => void;
  onRetryAi: (target: "profile" | "report", reportId?: number) => void;
  onTab: (tab: SiteTab) => void;
};

const PRIORITY_TONE = { P0: "danger", P1: "fire", P2: "neutral" } as const;
const SOURCE_LABEL: Record<string, string> = { seo: "техника", geo: "разметка", content: "контент" };

function reportNumber(value: number | null | undefined, fallback = "—") {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? fallback : String(value);
}

/** Короткая подпись URL-доказательства: домен или путь. */
function shortUrl(value: string) {
  try {
    const url = new URL(value);
    return url.pathname === "/" ? url.host : url.pathname;
  } catch {
    return value.slice(0, 60);
  }
}

export function ReportsPanel({ siteId, profile, reports, reportRequested, retryingAi, onRequestReport, onRetryAi, onTab }: Props) {
  const [showDone, setShowDone] = useState(false);
  const latest = reports[0] ?? null;
  const recommendations = latest?.recommendations ?? [];
  const open = recommendations.filter((item) => item.status === "open");
  const done = recommendations.filter((item) => item.status === "done");

  if (!profile && reports.length === 0) {
    return (
      <Card className="p-6">
        <p className="type-body-strong text-text">Отчётов пока нет</p>
        <p className="type-secondary mt-1 text-text-2">Первый отчёт Аврора собирает сразу после аудита: цифры, рекомендации и объяснение простым языком.</p>
        <Button type="button" size="sm" className="mt-4" onClick={() => onTab("audit")}>
          Перейти к аудиту<ArrowRight className="h-4 w-4" aria-hidden />
        </Button>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="type-h3 text-text">Отчёты сайта · {reports.length}</h3>
          <p className="type-caption mt-1 text-text-3">
            Ежемесячный отчёт собирается 1-го числа, Markdown-версия попадает в базу знаний сайта — следующий отчёт сравнивает рекомендации с прошлыми.
          </p>
        </div>
        <Button type="button" size="sm" variant="secondary" onClick={onRequestReport} disabled={reportRequested || !profile}>
          <RefreshCw className={cn("h-4 w-4", reportRequested && "animate-spin")} aria-hidden />
          {reportRequested ? "Собираем…" : "Собрать отчёт за 30 дней"}
        </Button>
      </div>
      {!profile && <p className="type-caption text-text-3">Отчёт по запросу станет доступен после первого аудита.</p>}

      {latest && (
        <Card>
          <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4 sm:px-6">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-info-soft text-brand">
              <FileText className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <h4 className="type-body-strong text-text">{REPORT_KIND_LABEL[latest.kind]} · {formatDate(latest.createdAt)}</h4>
              <p className="type-caption text-text-3">
                {latest.period?.start && latest.period?.end
                  ? `Период ${formatDate(latest.period.start)} — ${formatDate(latest.period.end)}`
                  : "Первый срез сайта: база для сравнения следующих отчётов"}
              </p>
            </div>
            <div className="ml-auto flex flex-wrap gap-2">
              {(["pdf", "markdown", "html"] as const).map((format) => (
                <a
                  key={format}
                  href={projectUrl(`/api/sites/${siteId}/reports/${latest.id}/export?format=${format}`)}
                  download
                  className="type-caption inline-flex min-h-9 items-center gap-1.5 rounded-sm border border-line px-2.5 py-1.5 font-semibold text-brand hover:border-brand/35 hover:bg-info-soft"
                >
                  <Download className="h-3.5 w-3.5" aria-hidden />{format === "markdown" ? "Markdown" : format.toUpperCase()}
                </a>
              ))}
            </div>
          </div>

          <div className="grid border-line lg:grid-cols-2 [&>div+div]:border-t lg:[&>div+div]:border-t-0 lg:[&>div+div]:border-l">
            <div className="px-5 py-5 sm:px-6">
              <p className="type-label text-text-2">Цифры периода</p>
              <p className="type-secondary mt-3 text-text-2">{latest.summaryRu}</p>
              {latest.metrics && (
                <div className="mt-4 grid grid-cols-3 gap-3">
                  <div className="rounded-sm bg-surface-inset p-3">
                    <span className="type-caption block text-text-3">Опубликовано</span>
                    <span className="type-h3 block text-text">{reportNumber(latest.metrics.published)}</span>
                  </div>
                  <div className="rounded-sm bg-surface-inset p-3">
                    <span className="type-caption block text-text-3">Ждут одобрения</span>
                    <span className="type-h3 block text-text">{reportNumber(latest.metrics.pendingReview)}</span>
                  </div>
                  <div className="rounded-sm bg-surface-inset p-3">
                    <span className="type-caption block text-text-3">Рекомендаций открыто</span>
                    <span className="type-h3 block text-text">{reportNumber(latest.metrics.openRecommendations, "0")}</span>
                  </div>
                </div>
              )}
              {latest.metrics && (
                <>
                  <p className="type-label mt-5 text-text-2">Изменения к прошлому отчёту</p>
                  <ul className="mt-2">
                    <li className="flex items-center justify-between gap-3 border-t border-line py-2.5">
                      <span className="type-caption text-text-2">Пробелов в темах</span>
                      <span className="type-caption text-text-3">{reportNumber(latest.metrics.gaps, "—")}</span>
                    </li>
                    <li className="flex items-center justify-between gap-3 border-t border-line py-2.5">
                      <span className="type-caption text-text-2">Рекомендаций закрыто</span>
                      <span className={cn("type-caption", latest.metrics.doneRecommendations > 0 ? "text-success-text" : "text-text-3")}>
                        {reportNumber(latest.metrics.doneRecommendations, "0")}
                      </span>
                    </li>
                    <li className="flex items-center justify-between gap-3 border-y border-line py-2.5">
                      <span className="type-caption text-text-2">Оценка on-page SEO</span>
                      <span className="type-caption text-text-3">
                        {reportNumber(latest.scores?.seo ?? null, "—")} {latest.scores?.geo !== null && latest.scores?.geo !== undefined ? `· ИИ-поиск ${reportNumber(latest.scores?.geo, "—")}` : ""}
                      </span>
                    </li>
                  </ul>
                </>
              )}
            </div>

            <div className="px-5 py-5 sm:px-6">
              <InterpretationBlock
                interpretation={latest.interpretation}
                status={latest.interpretationStatus}
                retrying={retryingAi !== null}
                onRetry={() => onRetryAi("report", latest.id)}
              />
              {!latest.interpretation && latest.interpretationStatus === "ready" && (
                <p className="type-caption mt-3 text-text-3">Цифры выше — источник истины: они собраны детерминированно по страницам сайта.</p>
              )}

              {/* Правая колонка не должна пустовать, пока объяснение готовится:
                  показываем очередь работ и честные границы измерения. */}
              {open.length > 0 && (
                <>
                  <p className="type-label mt-5 text-text-2">Что делать в первую очередь</p>
                  <ol className="mt-2 space-y-2">
                    {open.slice(0, 3).map((item, index) => (
                      <li key={item.key} className="flex gap-2">
                        <span className="type-caption font-semibold text-brand">{index + 1}.</span>
                        <span className="min-w-0">
                          <span className="type-caption block text-text-2">{item.title}</span>
                          <span className="type-caption text-text-3">{SOURCE_LABEL[item.source] ?? item.source} · {item.priority}</span>
                        </span>
                      </li>
                    ))}
                  </ol>
                </>
              )}

              {latest.competitors && latest.competitors.rows.length > 0 && (
                <>
                  <p className="type-label mt-5 text-text-2">Сравнение с конкурентами</p>
                  <ul className="mt-2 space-y-1.5">
                    <li className="type-caption text-text-2">
                      Ваш сайт: {latest.competitors.own?.pages ?? "—"} стр. · {latest.competitors.own?.avgWords ?? "—"} слов · разметка {latest.competitors.own?.pagesWithSchema ?? 0} из {latest.competitors.own?.pages ?? 0}
                    </li>
                    {latest.competitors.rows.map((row) => (
                      <li key={row.domain} className="type-caption text-text-2">
                        {row.domain}: {row.pages} стр. · {row.avgWords} слов · разметка {row.pagesWithSchema} из {row.pages} · Organization {row.hasOrganization ? "есть" : "нет"}
                      </li>
                    ))}
                  </ul>
                  {latest.competitors.missingThemes.length > 0 && (
                    <p className="type-caption mt-2 text-text-3">
                      Темы, которых у вас нет: {latest.competitors.missingThemes.map((item) => `${item.theme} (${item.competitor})`).join(", ")}
                    </p>
                  )}
                </>
              )}

              {latest.limitations && latest.limitations.length > 0 && (
                <div className="mt-5 rounded-sm bg-surface-2 p-3">
                  <p className="type-caption font-semibold text-text-3">Что этот отчёт не измеряет</p>
                  <ul className="mt-1.5 space-y-1">
                    {latest.limitations.slice(0, 3).map((item) => (
                      <li key={item} className="type-caption text-text-3">• {item}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      {recommendations.length > 0 && (
        <div className="grid items-start gap-5 lg:grid-cols-12">
          <Card className="lg:col-span-7">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 sm:px-6">
              <div>
                <h3 className="type-h3 text-text">Рекомендации · {open.length} {plural(open.length, "открыта", "открыты", "открыто")}</h3>
                <p className="type-caption mt-0.5 text-text-3">
                  Статус обновляется сам: рекомендация закрывается, когда проблема исчезает из нового аудита
                </p>
              </div>
              {done.length > 0 && (
                <Button type="button" size="sm" variant="ghost" onClick={() => setShowDone((value) => !value)}>
                  {showDone ? "Скрыть закрытые" : `Закрытые · ${done.length}`}
                </Button>
              )}
            </div>
            <ul>
              {[...open, ...(showDone ? done : [])].slice(0, 24).map((item, index) => (
                <li key={item.key} className={cn("flex items-start gap-3 px-5 py-4 sm:px-6", index > 0 && "border-t border-line")}>
                  <span className={cn(
                    "grid h-8 w-8 shrink-0 place-items-center rounded-sm",
                    item.status === "done" ? "bg-success-soft text-success-text" : item.priority === "P0" ? "bg-danger-soft text-danger-text" : "bg-fire-soft text-fire-text",
                  )}>
                    {item.status === "done" ? <Check className="h-4 w-4" aria-hidden /> : <AlertTriangleIcon />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="type-body-strong text-text">{item.title}</p>
                      <Badge tone={item.status === "done" ? "success" : PRIORITY_TONE[item.priority as keyof typeof PRIORITY_TONE] ?? "neutral"}>
                        {item.status === "done" ? "закрыта" : item.priority}
                      </Badge>
                      <span className="type-caption text-text-3">{SOURCE_LABEL[item.source] ?? item.source}</span>
                    </div>
                    <p className="type-caption mt-1 text-text-2">{item.rationale}</p>
                    {item.evidenceUrls.length > 0 && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="type-caption text-text-3">Где смотреть:</span>
                        {item.evidenceUrls.slice(0, 3).map((url) => (
                          <a key={url} href={url} target="_blank" rel="noopener noreferrer" className="type-caption inline-flex items-center gap-1 text-brand hover:underline">
                            <ExternalLink className="h-3 w-3" aria-hidden />{shortUrl(url)}
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                  {item.status === "open" && item.source === "content" && (
                    <Button type="button" size="sm" variant="ghost" onClick={() => onTab("materials")}>Создать материал</Button>
                  )}
                </li>
              ))}
            </ul>
          </Card>

          <Card className="lg:col-span-5">
            <div className="border-b border-line px-5 py-4 sm:px-6">
              <h3 className="type-h3 text-text">История отчётов</h3>
            </div>
            <ul>
              {reports.slice(0, 8).map((report, index) => (
                <li key={report.id} className={cn("flex items-center gap-3 px-5 py-4 sm:px-6", index > 0 && "border-t border-line")}>
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-surface-inset text-text-2">
                    <FileText className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="type-body-strong block text-text">{REPORT_KIND_LABEL[report.kind]}</span>
                    <span className="type-caption text-text-3">
                      {formatDate(report.createdAt)}
                      {report.metrics ? ` · открыто ${report.metrics.openRecommendations}, закрыто ${report.metrics.doneRecommendations}` : ""}
                    </span>
                  </span>
                  <a
                    href={projectUrl(`/api/sites/${siteId}/reports/${report.id}/export?format=pdf`)}
                    download
                    className="type-caption inline-flex min-h-9 items-center gap-1.5 rounded-sm border border-line px-2.5 py-1.5 font-semibold text-brand hover:border-brand/35 hover:bg-info-soft"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden />PDF
                  </a>
                </li>
              ))}
            </ul>
            <p className="type-caption border-t border-line px-5 py-4 text-text-3 sm:px-6">
              Прогоны аудита и что менялось между ними хранятся здесь же — не нужно искать их в отдельном разделе.
            </p>
          </Card>
        </div>
      )}
    </div>
  );
}

function AlertTriangleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}
