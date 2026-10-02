"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Check, ExternalLink, RefreshCw, Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

import { formatDate } from "./client";
import { ProbePanel } from "./probe-panel";
import { SEVERITY_LABEL, SEVERITY_TONE, plural, type AnalysisView, type Gap, type Issue, type ProfileView } from "./types";

/** Из вида пробела понятно, какой материал его закрывает. */
function articleTypeForGap(gap: Gap): string {
  switch (gap.kind) {
    case "page_type_missing":
      return gap.key.includes("article") ? "evergreen_guide" : "machine_readable_page";
    case "schema_missing":
      return "machine_readable_page";
    case "question_without_answer":
      return "audience_answer";
    default:
      return "evergreen_guide";
  }
}

/** Тема материала: для вопроса — сам вопрос, иначе формулировка пробела. */
function briefForGap(gap: Gap): string {
  const brief = gap.kind === "question_without_answer"
    ? `${gap.label}. Ответить прямо и по делу, с опорой на факты сайта.`
    : `${gap.label}. ${gap.detail}`;
  return brief.slice(0, 400);
}

type Props = {
  siteId: number;
  retryingAi: string | null;
  onRetryAi: (target: "profile" | "report", reportId?: number) => void;
  verified: boolean;
  profile: ProfileView | null;
  analysis: AnalysisView | null;
  reanalyzing: boolean;
  analysisActive: boolean;
  maxPages: number;
  onMaxPagesChange: (value: number) => void;
  onReanalyze: () => void;
  /** Пробел превращается в задание на материал: тема и тип уже выбраны. */
  onCreateMaterial: (input: { brief: string; type: string }) => void;
};

const SCORE_LABEL = (value: number | null) => (value === null ? "не измерено" : value >= 85 ? "сильно" : value >= 60 ? "средне" : "слабо");
const SCORE_TONE = (value: number | null): "success" | "fire" | "danger" | "neutral" =>
  value === null ? "neutral" : value >= 85 ? "success" : value >= 60 ? "fire" : "danger";
const BAR_TONE = (value: number | null) => (value === null ? "" : value >= 85 ? "bg-success" : value >= 60 ? "bg-fire" : "bg-danger");

function issueRows(profile: ProfileView): Issue[] {
  return [...profile.technical.seoIssues, ...profile.technical.geoIssues];
}

/** Короткая подпись ссылки: домен для главной, путь для внутренней страницы. */
function shortUrl(value: string) {
  try {
    const url = new URL(value);
    return url.pathname === "/" ? url.host : url.pathname;
  } catch {
    return value.slice(0, 60);
  }
}

export function AuditPanel({
  siteId,
  retryingAi,
  onRetryAi,
  verified,
  profile,
  analysis,
  reanalyzing,
  analysisActive,
  maxPages,
  onMaxPagesChange,
  onReanalyze,
  onCreateMaterial,
}: Props) {
  const [showAllIssues, setShowAllIssues] = useState(false);
  const issues = useMemo(() => (profile ? issueRows(profile) : []), [profile]);
  const visibleIssues = showAllIssues ? issues : issues.slice(0, 6);
  const maxTopicPages = Math.max(1, ...(profile?.topics.map((topic) => topic.pageCount) ?? [1]));
  const highGaps = profile?.gaps.filter((gap) => gap.severity === "high") ?? [];
  const otherGaps = profile?.gaps.filter((gap) => gap.severity !== "high") ?? [];
  const clientRendered = profile?.technical.clientRenderedPages ?? 0;

  if (!profile) {
    return (
      <Card className="p-6">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-sm bg-info-soft text-brand">
            <RefreshCw className={cn("h-5 w-5", (reanalyzing || analysisActive) && "animate-spin")} aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="type-body-strong text-text">
              {analysisActive ? "Аудит идёт" : analysis?.status === "failed" ? "Аудит завершился ошибкой" : "Аудита ещё не было"}
            </p>
            <p className="type-secondary mt-1 text-text-2">
              {analysisActive
                ? "Как только обход закончится, здесь появятся темы, пробелы и технические замечания."
                : analysis?.status === "failed"
                  ? "Запустите аудит заново — прошлый прогон не собрал профиль."
                  : "Запустите аудит: Аврора прочитает публичные страницы и покажет, что мешает сайту."}
            </p>
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <label className="type-caption text-text-3" htmlFor="audit-max-pages-empty">
                Сколько страниц читать
                <select
                  id="audit-max-pages-empty"
                  className="type-input ml-2 rounded-sm border border-line bg-surface px-2.5 py-1.5 text-text"
                  value={maxPages}
                  onChange={(event) => onMaxPagesChange(Number(event.target.value))}
                >
                  <option value={20}>20 — быстро</option>
                  <option value={35}>35 — полнее</option>
                  <option value={50}>50 — максимум</option>
                </select>
              </label>
              <Button type="button" size="sm" disabled={reanalyzing || analysisActive} onClick={onReanalyze}>
                <RefreshCw className={cn("h-4 w-4", (reanalyzing || analysisActive) && "animate-spin")} aria-hidden />
                {analysisActive ? "Аудит идёт" : "Запустить аудит"}
              </Button>
            </div>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      {/* Полоса метрик: одна карточка вместо россыпи — так нет пустых окон между ними */}
      <Card>
        <div className="grid border-line sm:grid-cols-2 lg:grid-cols-4 [&>div+div]:border-t sm:[&>div+div]:border-t-0 sm:[&>div+div]:border-l">
          {[
            { label: "On-page SEO", value: profile.technical.seoScore, note: `${profile.technical.seoIssues.length} ${plural(profile.technical.seoIssues.length, "замечание", "замечания", "замечаний")} по страницам` },
            { label: "Готовность к ИИ-поиску", value: profile.technical.geoScore, note: `${profile.technical.geoIssues.length} ${plural(profile.technical.geoIssues.length, "замечание", "замечания", "замечаний")} по разметке` },
          ].map((item) => (
            <div key={item.label} className="p-4 sm:p-5">
              <span className="type-caption block text-text-3">{item.label}</span>
              <span className="mt-1 flex items-baseline gap-2">
                <span className="text-[28px] font-semibold leading-none text-text">{item.value ?? "—"}</span>
                {item.value !== null && <span className="type-caption text-text-3">/ 100</span>}
                <Badge tone={SCORE_TONE(item.value)} className="ml-auto">{SCORE_LABEL(item.value)}</Badge>
              </span>
              <span className="mt-3 block h-1.5 overflow-hidden rounded-full bg-surface-inset">
                <span className={cn("block h-full rounded-full", BAR_TONE(item.value))} style={{ width: `${item.value ?? 0}%` }} />
              </span>
              <span className="type-caption mt-2 block text-text-3">{item.note}</span>
            </div>
          ))}
          <div className="p-4 sm:p-5">
            <span className="type-caption block text-text-3">Страниц проверено</span>
            <span className="mt-1 block text-[28px] font-semibold leading-none text-text">{profile.technical.pagesChecked}</span>
            <span className="mt-3 block h-1.5 overflow-hidden rounded-full bg-surface-inset">
              <span className="block h-full rounded-full bg-brand" style={{ width: `${Math.min(100, Math.round((profile.technical.pagesChecked / Math.max(1, maxPages)) * 100))}%` }} />
            </span>
            <span className="type-caption mt-2 block text-text-3">
              из {maxPages}, которые разрешил лимит обхода
              {clientRendered > 0 ? ` · ${clientRendered} на JavaScript` : ""}
            </span>
          </div>
          <div className="p-4 sm:p-5">
            <span className="type-caption block text-text-3">Темы и пробелы</span>
            <span className="mt-1 block text-[28px] font-semibold leading-none text-text">
              {profile.topics.length} <span className={profile.gaps.length ? "text-danger-text" : "text-text-3"}>/ {profile.gaps.length}</span>
            </span>
            <span className="mt-3 block h-1.5 overflow-hidden rounded-full bg-surface-inset">
              <span className="block h-full rounded-full bg-fire" style={{ width: `${Math.min(100, Math.round((highGaps.length / Math.max(1, profile.gaps.length)) * 100))}%` }} />
            </span>
            <span className="type-caption mt-2 block text-text-3">{highGaps.length} {plural(highGaps.length, "критичный пробел", "критичных пробела", "критичных пробелов")}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3 sm:px-6">
          <div className="flex flex-wrap items-center gap-2">
            {profile.refinedAt ? (
              <span className="type-caption text-text-3">уточнён моделью {formatDate(profile.refinedAt, true)}</span>
            ) : profile.aiClassification?.status === "failed" ? (
              <>
                <Badge tone="danger">уточнение не удалось</Badge>
                <Button type="button" size="sm" variant="secondary" disabled={retryingAi !== null} onClick={() => onRetryAi("profile")}>
                  {retryingAi === "profile" ? "Запускаем…" : "Повторить уточнение"}
                </Button>
              </>
            ) : (
              <span className="type-caption text-text-3">
                {profile.aiClassification?.status === "processing" ? "уточняем профиль" : "уточнение ожидает запуска"}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="type-caption text-text-3" htmlFor="audit-max-pages">
              Лимит обхода
              <select
                id="audit-max-pages"
                className="type-input ml-2 rounded-sm border border-line bg-surface px-2.5 py-1.5 text-text"
                value={maxPages}
                onChange={(event) => onMaxPagesChange(Number(event.target.value))}
              >
                <option value={20}>20 страниц</option>
                <option value={35}>35 страниц</option>
                <option value={50}>50 страниц</option>
              </select>
            </label>
            <Button type="button" size="sm" variant="secondary" disabled={reanalyzing || analysisActive} onClick={onReanalyze}>
              <RefreshCw className={cn("h-4 w-4", (reanalyzing || analysisActive) && "animate-spin")} aria-hidden />
              Обновить аудит
            </Button>
          </div>
        </div>
      </Card>

      <div className="grid items-start gap-5 lg:grid-cols-12">
        <Card className="lg:col-span-5">
          <div className="border-b border-line px-5 py-4 sm:px-6">
            <h3 className="type-h3 text-text">Темы сайта</h3>
            <p className="type-caption mt-0.5 text-text-3">Сколько страниц раскрывают тему и насколько глубоко</p>
          </div>
          {profile.topics.length === 0 ? (
            <p className="type-secondary px-5 py-5 text-text-2 sm:px-6">Устойчивых тем между страницами не найдено.</p>
          ) : (
            <ul className="space-y-4 px-5 py-5 sm:px-6">
              {profile.topics.slice(0, 8).map((topic) => (
                <li key={topic.key}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="type-body-strong text-text">{topic.label}</span>
                    <span className="type-caption text-text-3">
                      {topic.pageCount} {plural(topic.pageCount, "страница", "страницы", "страниц")} · {topic.coverage === "strong" ? "глубоко" : "тонко"}
                    </span>
                  </div>
                  <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-surface-inset">
                    <span
                      className={cn("block h-full rounded-full", topic.coverage === "strong" ? "bg-success" : "bg-fire")}
                      style={{ width: `${Math.max(8, Math.round((topic.pageCount / maxTopicPages) * 100))}%` }}
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="lg:col-span-7">
          <div className="border-b border-line px-5 py-4 sm:px-6">
            <h3 className="type-h3 text-text">Технические замечания</h3>
            <p className="type-caption mt-0.5 text-text-3">
              Проверено на {profile.technical.pagesChecked} страницах · у каждого замечания указано, где смотреть
            </p>
          </div>
          {issues.length === 0 ? (
            <p className="type-secondary px-5 py-5 text-success-text sm:px-6">Технических замечаний нет.</p>
          ) : (
            <>
              <ul>
                {visibleIssues.map((issue, index) => (
                  <li key={issue.id} className={cn("px-5 py-4 sm:px-6", index > 0 && "border-t border-line")}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={issue.status === "critical" ? "danger" : "fire"}>
                        {issue.status === "critical" ? "критично" : "важно"}
                      </Badge>
                      <p className="type-body-strong text-text">{issue.label}</p>
                    </div>
                    <p className="type-caption mt-1 text-text-2">{issue.detail}</p>
                    <p className="type-caption mt-1 font-semibold text-text">{issue.recommendation}</p>
                    {issue.evidenceUrls && issue.evidenceUrls.length > 0 && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="type-caption text-text-3">Где смотреть:</span>
                        {issue.evidenceUrls.slice(0, 3).map((url) => (
                          <a
                            key={url}
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="type-caption inline-flex items-center gap-1 text-brand hover:underline"
                          >
                            <ExternalLink className="h-3 w-3" aria-hidden />
                            {shortUrl(url)}
                          </a>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {issues.length > visibleIssues.length && (
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3 sm:px-6">
                  <span className="type-caption text-text-3">Показаны {visibleIssues.length} из {issues.length}</span>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setShowAllIssues(true)}>Показать все</Button>
                </div>
              )}
            </>
          )}
        </Card>
      </div>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 sm:px-6">
          <div>
            <h3 className="type-h3 text-text">Пробелы в темах · {profile.gaps.length}</h3>
            <p className="type-caption mt-0.5 text-text-3">Из пробела можно сразу поставить материал — Аврора подставит тему и источники</p>
          </div>
          {profile.gaps.length > 0 && (
            <Button
              type="button"
              size="sm"
              onClick={() => onCreateMaterial({ brief: briefForGap([...highGaps, ...otherGaps][0]), type: articleTypeForGap([...highGaps, ...otherGaps][0]) })}
            >
              <Sparkles className="h-4 w-4" aria-hidden />Предложить материалы
            </Button>
          )}
        </div>
        {profile.gaps.length === 0 ? (
          <p className="type-secondary px-5 py-5 text-success-text sm:px-6">Пробелов не найдено.</p>
        ) : (
          <div className="grid gap-4 p-5 sm:p-6 md:grid-cols-2">
            {[...highGaps, ...otherGaps].slice(0, 8).map((gap) => (
              <div key={gap.key} className="rounded-sm border border-line bg-surface-2 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={SEVERITY_TONE[gap.severity]}>{SEVERITY_LABEL[gap.severity]}</Badge>
                  <span className="type-caption text-text-3">{gap.kind.replaceAll("_", " ")}</span>
                </div>
                <p className="type-body-strong mt-2 text-text">{gap.label}</p>
                <p className="type-caption mt-1 text-text-2">{gap.detail}</p>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => onCreateMaterial({ brief: briefForGap(gap), type: articleTypeForGap(gap) })}
                  >
                    Создать материал
                  </Button>
                  {gap.evidenceUrls.length > 0 && (
                    <a
                      href={gap.evidenceUrls[0]}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="type-caption inline-flex items-center gap-1 text-brand hover:underline"
                    >
                      <ExternalLink className="h-3 w-3" aria-hidden />
                      доказательство: {shortUrl(gap.evidenceUrls[0])}
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {profile.gaps.length > 8 && (
          <p className="type-caption border-t border-line px-5 py-3 text-text-3 sm:px-6">
            Показаны 8 из {profile.gaps.length}. Остальные закроются по мере выхода материалов.
          </p>
        )}
      </Card>

      <ProbePanel siteId={siteId} verified={verified} hasProfile={Boolean(profile)} />

      <Card>
        <div className="border-b border-line px-5 py-4 sm:px-6">
          <h3 className="type-h3 text-text">Границы этого аудита</h3>
          <p className="type-caption mt-0.5 text-text-3">Честный список того, чего в отчёте нет</p>
        </div>
        <ul className="grid gap-4 px-5 py-5 sm:px-6 md:grid-cols-2">
          <li className="flex gap-3">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-danger-soft text-danger-text"><X className="h-4 w-4" aria-hidden /></span>
            <span>
              <span className="type-body-strong block text-text">Позиции и трафик</span>
              <span className="type-caption text-text-2">Нужны Яндекс.Вебмастер и Search Console — интеграции пока нет, поэтому цифр нет и выдумывать их Аврора не будет.</span>
            </span>
          </li>
          <li className="flex gap-3">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-danger-soft text-danger-text"><X className="h-4 w-4" aria-hidden /></span>
            <span>
              <span className="type-body-strong block text-text">Ссылки и упоминания на других сайтах</span>
              <span className="type-caption text-text-2">Аврора читает только ваш сайт, чужие площадки не обходит.</span>
            </span>
          </li>
          <li className="flex gap-3">
            <span className={cn(
              "grid h-8 w-8 shrink-0 place-items-center rounded-sm",
              clientRendered > 0 ? "bg-fire-soft text-fire-text" : "bg-surface-inset text-text-2",
            )}>
              <AlertTriangle className="h-4 w-4" aria-hidden />
            </span>
            <span>
              <span className="type-body-strong block text-text">
                Страницы на JavaScript{clientRendered > 0 ? ` · ${clientRendered}` : ""}
              </span>
              <span className="type-caption text-text-2">
                {clientRendered > 0
                  ? `Обход читает HTML без исполнения скриптов: ${clientRendered} ${plural(clientRendered, "страница отдала", "страницы отдали", "страниц отдали")} пустой HTML, их содержимое не оценивалось. Нужен серверный рендеринг или пререндер.`
                  : "Обход читает HTML без исполнения скриптов: если содержимое рисует JavaScript, оно не попадёт в оценку — таких страниц сейчас не найдено."}
              </span>
            </span>
          </li>
          <li className="flex gap-3">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-fire-soft text-fire-text"><AlertTriangle className="h-4 w-4" aria-hidden /></span>
            <span>
              <span className="type-body-strong block text-text">Только первые {maxPages} страниц сайта</span>
              <span className="type-caption text-text-2">Лимит обхода можно поднять до 50 выше в этом экране — если сайт больше, увеличьте и обновите аудит.</span>
            </span>
          </li>
          <li className="flex gap-3">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-success-soft text-success-text"><Check className="h-4 w-4" aria-hidden /></span>
            <span>
              <span className="type-body-strong block text-text">Что читается точно</span>
              <span className="type-caption text-text-2">Заголовки, тексты, canonical, noindex, schema.org, alt, ссылки, формы и контакты.</span>
            </span>
          </li>
        </ul>
      </Card>
    </div>
  );
}
