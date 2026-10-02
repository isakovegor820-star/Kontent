"use client";

import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Download,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/primitives";
import { projectUrl } from "@/lib/project-transport";
import { cn } from "@/lib/utils";

import { formatDate } from "./client";
import { InterpretationBlock } from "./interpretation-block";
import { REPORT_KIND_LABEL, type AnalysisView, type ArticleStats, type ProfileView, type ReportView, type SiteSummary, type SiteTab } from "./types";

export type OverviewStep = {
  key: string;
  title: string;
  body: string;
  urgency: "danger" | "normal";
  primary?: { label: string; onClick: () => void };
  secondary?: { label: string; onClick: () => void };
};

type Props = {
  site: SiteSummary;
  profile: ProfileView | null;
  analysis: AnalysisView | null;
  reports: ReportView[];
  articleStats: ArticleStats | null;
  destinationCount: number;
  destinationsLoaded: boolean;
  reanalyzing: boolean;
  analysisActive: boolean;
  retryingAi: string | null;
  onOpenVerification: () => void;
  onVerify: () => void;
  onTab: (tab: SiteTab) => void;
  onReanalyze: () => void;
  onRetryAi: (target: "profile" | "report", reportId?: number) => void;
};

/** План собирается из состояния сайта: сначала то, что разблокирует остальное. */
export function buildOverviewSteps(input: {
  site: SiteSummary;
  profile: ProfileView | null;
  analysis: AnalysisView | null;
  pendingArticles: number;
  destinationCount: number;
  destinationsLoaded: boolean;
  onOpenVerification: () => void;
  onVerify: () => void;
  onTab: (tab: SiteTab) => void;
  onReanalyze: () => void;
}): OverviewStep[] {
  const steps: OverviewStep[] = [];
  const highGaps = input.profile?.gaps.filter((gap) => gap.severity === "high").length ?? 0;

  if (input.site.verification.state !== "verified") {
    steps.push({
      key: "verify",
      title: "Подтвердить домен",
      body: "Пока домен не подтверждён, публикация на сайт и зонд видимости в ИИ закрыты. Это две минуты: TXT-запись в DNS или meta-тег на главной.",
      urgency: "danger",
      primary: { label: "Показать 2 способа", onClick: input.onOpenVerification },
      secondary: { label: "Уже добавил — проверить", onClick: input.onVerify },
    });
  }

  if (!input.profile && input.analysis && input.analysis.status === "failed") {
    steps.push({
      key: "analysis",
      title: "Перезапустить аудит",
      body: "Прошлый прогон завершился ошибкой, поэтому профиля сайта нет. Обычно помогает повторный запуск.",
      urgency: "danger",
      primary: { label: "Запустить аудит", onClick: input.onReanalyze },
    });
  }

  if (highGaps > 0) {
    steps.push({
      key: "gaps",
      title: `Закрыть ${highGaps} ${highGaps === 1 ? "критичный пробел" : "критичных пробела"} в темах`,
      body: "Это то, что мешает поиску и ИИ-движкам понимать сайт: нет обязательных страниц, разметки или ответов на вопросы клиентов.",
      urgency: "danger",
      primary: { label: "Открыть пробелы", onClick: () => input.onTab("audit") },
      secondary: { label: "Предложить материалы", onClick: () => input.onTab("materials") },
    });
  }

  if (input.pendingArticles > 0) {
    steps.push({
      key: "articles",
      title: `Одобрить материалы, которые ждут решения: ${input.pendingArticles}`,
      body: "Публикация начнётся после подтверждения домена, но одобрить и поправить тексты можно уже сейчас.",
      urgency: "normal",
      primary: { label: "Перейти к материалам", onClick: () => input.onTab("materials") },
    });
  }

  if (input.destinationsLoaded && input.destinationCount === 0) {
    steps.push({
      key: "destinations",
      title: "Подключить назначение публикации",
      body: "WordPress по REST API или раздел с материалами на домене Авроры. Без назначения материалы останутся внутри Авроры.",
      urgency: "normal",
      primary: { label: "Выбрать назначение", onClick: () => input.onTab("publishing") },
    });
  }

  if (input.profile && input.site.verification.state === "verified" && input.destinationCount > 0 && input.pendingArticles === 0) {
    steps.push({
      key: "steady",
      title: "Сайт в рабочем режиме",
      body: "Аудит собран, назначение подключено, очередь материалов пуста. Аврора продолжит планировать материалы по профилю сайта.",
      urgency: "normal",
      primary: { label: "Посмотреть аудит", onClick: () => input.onTab("audit") },
    });
  }

  return steps;
}

export function OverviewPanel({
  site,
  profile,
  analysis,
  reports,
  articleStats,
  destinationCount,
  destinationsLoaded,
  reanalyzing,
  analysisActive,
  retryingAi,
  onOpenVerification,
  onVerify,
  onTab,
  onReanalyze,
  onRetryAi,
}: Props) {
  const steps = buildOverviewSteps({
    site, profile, analysis, onOpenVerification, onVerify, onTab, onReanalyze,
    pendingArticles: articleStats?.pending ?? 0,
    destinationCount,
    destinationsLoaded,
  });
  const latestReport = reports[0] ?? null;
  const strongTopics = profile?.topics.filter((topic) => topic.coverage === "strong").length ?? 0;

  return (
    <div className="grid items-start gap-5 lg:grid-cols-12">
      {/* Что делать дальше — единственный блок, который всегда отвечает «что мне делать» */}
      <Card className="lg:col-span-7">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 sm:px-6">
          <div>
            <h3 className="type-h3 text-text">Что делать дальше</h3>
            <p className="type-caption mt-0.5 text-text-3">Порядок собран из состояния сайта: сначала то, что разблокирует остальное</p>
          </div>
          {steps.length > 0 && <Badge tone="brand">{steps.length === 1 ? "1 шаг" : `${steps.length} шага`}</Badge>}
        </div>

        {steps.length === 0 ? (
          <div className="flex items-start gap-3 px-5 py-6 sm:px-6">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-success-soft text-success-text">
              <CheckCircle2 className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <p className="type-body-strong text-text">Срочных шагов нет</p>
              <p className="type-secondary mt-1 text-text-2">Аудит собран, материалы в работе. Аврора обновит отчёт 1-го числа.</p>
            </div>
          </div>
        ) : (
          <ol>
            {steps.map((step, index) => (
              <li key={step.key} className={cn("flex gap-4 px-5 py-4 sm:px-6", index > 0 && "border-t border-line")}>
                <span className={cn(
                  "grid h-7 w-7 shrink-0 place-items-center rounded-full text-[13px] font-bold",
                  step.urgency === "danger" ? "bg-danger-soft text-danger-text" : "bg-surface-inset text-text-2",
                )}>
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="type-body-strong text-text">{step.title}</p>
                  <p className="type-caption mt-1 text-text-2">{step.body}</p>
                  {(step.primary || step.secondary) && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {step.primary && (
                        <Button type="button" size="sm" variant={step.urgency === "danger" ? "primary" : "secondary"} onClick={step.primary.onClick}>
                          {step.primary.label}
                        </Button>
                      )}
                      {step.secondary && (
                        <Button type="button" size="sm" variant="ghost" onClick={step.secondary.onClick}>{step.secondary.label}</Button>
                      )}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}

        {(profile || articleStats) && (
          <div className="border-t border-line bg-surface-2 px-5 py-4 sm:px-6">
            <p className="type-label text-text-2">Уже сделано</p>
            <ul className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
              <li className="type-caption flex items-center gap-1.5 text-text-2"><Check className="h-3.5 w-3.5 text-success-text" aria-hidden />Сайт подключён{site.createdAt ? ` ${formatDate(site.createdAt)}` : ""}</li>
              {profile && <li className="type-caption flex items-center gap-1.5 text-text-2"><Check className="h-3.5 w-3.5 text-success-text" aria-hidden />Аудит и профиль собраны</li>}
              {reports.length > 0 && <li className="type-caption flex items-center gap-1.5 text-text-2"><Check className="h-3.5 w-3.5 text-success-text" aria-hidden />Отчётов: {reports.length}</li>}
              {articleStats && articleStats.total > 0 && <li className="type-caption flex items-center gap-1.5 text-text-2"><Check className="h-3.5 w-3.5 text-success-text" aria-hidden />Материалов: {articleStats.total}</li>}
            </ul>
          </div>
        )}
      </Card>

      <div className="flex flex-col gap-5 lg:col-span-5">
        {profile?.summary && (
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 sm:px-6">
              <h3 className="type-h3 text-text">Что Аврора поняла о сайте</h3>
              {profile.refinedAt ? (
                <Badge tone="brand">уточнён моделью</Badge>
              ) : profile.aiClassification?.status === "failed" ? (
                <Badge tone="danger">уточнение не удалось</Badge>
              ) : profile.aiClassification?.status === "processing" ? (
                <Badge tone="neutral">уточняем профиль</Badge>
              ) : (
                <Badge tone="neutral">уточнение ожидает запуска</Badge>
              )}
            </div>
            <p className="type-secondary px-5 py-4 text-text-2 sm:px-6">{profile.summary}</p>
          </Card>
        )}

        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 sm:px-6">
            <div>
              <h3 className="type-h3 text-text">Состояние сайта</h3>
              <p className="type-caption mt-0.5 text-text-3">
                {profile?.createdAt ? `По аудиту от ${formatDate(profile.createdAt)}` : "Профиль ещё не собран"}
              </p>
            </div>
            {(reanalyzing || analysisActive) && (
              <Button type="button" size="sm" variant="ghost" disabled>
                <RefreshCw className="h-4 w-4 animate-spin" aria-hidden />Обновляем
              </Button>
            )}
          </div>

          {profile ? (
            <>
              <ul className="grid grid-cols-2 border-line [&>li]:border-t [&>li]:border-line [&>li:nth-child(-n+2)]:border-t-0 [&>li:nth-child(even)]:border-l">
                <li className="p-4 sm:p-5">
                  <span className="type-caption block text-text-3">Страниц в профиле</span>
                  <span className="mt-1 block text-[28px] font-semibold leading-none text-text">{profile.pageCount}</span>
                  <span className="type-caption mt-1 block text-text-3">{profile.technical.pagesChecked} проверено полностью</span>
                </li>
                <li className="p-4 sm:p-5">
                  <span className="type-caption block text-text-3">Темы сайта</span>
                  <span className="mt-1 block text-[28px] font-semibold leading-none text-text">{profile.topics.length}</span>
                  <span className="type-caption mt-1 block text-text-3">{strongTopics} раскрыты глубоко</span>
                </li>
                <li className="p-4 sm:p-5">
                  <span className="type-caption block text-text-3">Пробелы</span>
                  <span className={cn("mt-1 block text-[28px] font-semibold leading-none", profile.gaps.length ? "text-danger-text" : "text-text")}>{profile.gaps.length}</span>
                  <span className="type-caption mt-1 block text-text-3">
                    {profile.gaps.filter((gap) => gap.severity === "high").length} критичных
                  </span>
                </li>
                <li className="p-4 sm:p-5">
                  <span className="type-caption block text-text-3">Вопросы без ответа</span>
                  <span className="mt-1 block text-[28px] font-semibold leading-none text-text">{profile.technical.questions?.unansweredQuestions ?? 0}</span>
                  <span className="type-caption mt-1 block text-text-3">из реестра клиентов</span>
                </li>
              </ul>
              <div className="border-t border-line px-5 py-4 sm:px-6">
                <p className="type-label text-text-2">Чего Аврора пока не измеряет</p>
                <ul className="mt-2 space-y-1.5">
                  <li className="type-caption flex gap-2 text-text-2"><X className="h-3.5 w-3.5 shrink-0 text-danger-text" aria-hidden />Позиции в поиске и трафик: нужны Яндекс.Вебмастер и Search Console</li>
                  <li className="type-caption flex gap-2 text-text-2"><X className="h-3.5 w-3.5 shrink-0 text-danger-text" aria-hidden />Ссылки и упоминания на других сайтах: обходим только ваш сайт</li>
                  <li className="type-caption flex gap-2 text-text-2"><AlertTriangle className="h-3.5 w-3.5 shrink-0 text-fire-text" aria-hidden />Страницы, которые рисует JavaScript: обход читает HTML без скриптов</li>
                  <li className="type-caption flex gap-2 text-text-2"><Check className="h-3.5 w-3.5 shrink-0 text-success-text" aria-hidden />Точные данные внутри сайта: заголовки, тексты, canonical, schema.org, ссылки</li>
                </ul>
              </div>
            </>
          ) : (
            <div className="px-5 py-6 sm:px-6">
              <p className="type-secondary text-text-2">
                {analysisActive
                  ? "Аудит идёт. Профиль и первые выводы появятся сразу после завершения."
                  : analysis?.status === "failed"
                    ? "Аудит завершился ошибкой, поэтому профиля нет. Запустите его заново."
                    : "Аудит ещё не запускался. Запустите его, чтобы получить профиль сайта."}
              </p>
              <Button type="button" size="sm" variant="primary" className="mt-3" disabled={reanalyzing || analysisActive} onClick={onReanalyze}>
                <RefreshCw className={cn("h-4 w-4", (reanalyzing || analysisActive) && "animate-spin")} aria-hidden />
                {analysisActive ? "Аудит идёт" : "Запустить аудит"}
              </Button>
            </div>
          )}
        </Card>

        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 sm:px-6">
            <div>
              <h3 className="type-h3 text-text">
                {latestReport ? `${REPORT_KIND_LABEL[latestReport.kind]} · ${formatDate(latestReport.createdAt)}` : "Отчёты"}
              </h3>
              <p className="type-caption mt-0.5 text-text-3">
                {latestReport?.period?.start && latestReport?.period?.end
                  ? `Период ${formatDate(latestReport.period.start)} — ${formatDate(latestReport.period.end)}`
                  : "Стартовый аудит собирается сразу после первого анализа"}
              </p>
            </div>
          </div>
          {latestReport ? (
            <>
              <div className="space-y-3 px-5 py-4 sm:px-6">
                <p className="type-secondary text-text-2">{latestReport.summaryRu}</p>
                <InterpretationBlock
                  interpretation={latestReport.interpretation}
                  status={latestReport.interpretationStatus}
                  compact
                  retrying={retryingAi !== null}
                  onRetry={() => onRetryAi("report", latestReport.id)}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-4 sm:px-6">
                <a
                  href={projectUrl(`/api/sites/${site.id}/reports/${latestReport.id}/export?format=pdf`)}
                  download
                  className="type-caption inline-flex min-h-9 items-center gap-1.5 rounded-sm border border-line px-2.5 py-1.5 font-semibold text-brand hover:border-brand/35 hover:bg-info-soft"
                >
                  <Download className="h-3.5 w-3.5" aria-hidden />PDF
                </a>
                <a
                  href={projectUrl(`/api/sites/${site.id}/reports/${latestReport.id}/export?format=markdown`)}
                  download
                  className="type-caption inline-flex min-h-9 items-center gap-1.5 rounded-sm border border-line px-2.5 py-1.5 font-semibold text-brand hover:border-brand/35 hover:bg-info-soft"
                >
                  <Download className="h-3.5 w-3.5" aria-hidden />Markdown
                </a>
                <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={() => onTab("reports")}>
                  Все отчёты<ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </div>
            </>
          ) : (
            <div className="px-5 py-6 sm:px-6">
              <p className="type-secondary text-text-2">Первый отчёт появится после завершения аудита.</p>
              <Button type="button" size="sm" variant="secondary" className="mt-3" onClick={() => onTab("reports")}>
                <Sparkles className="h-4 w-4" aria-hidden />Что будет в отчёте
              </Button>
            </div>
          )}
        </Card>

      </div>
    </div>
  );
}
