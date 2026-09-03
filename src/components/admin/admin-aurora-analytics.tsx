"use client";

import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BarChart3,
  CheckCircle2,
  Clock3,
  Copy,
  ExternalLink,
  Gauge,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button, buttonClassName } from "@/components/ui/button";
import type {
  AdminAuroraAnalytics,
  AuroraAnalyticsErrorGroup,
  AuroraAnalyticsHealthState,
  AuroraAnalyticsSectionCard,
  AuroraAnalyticsTab,
  AuroraMetricValue,
  AuroraNullableMetricValue,
} from "@/lib/admin-aurora-analytics";
import {
  adminAnalyticsHref,
  adminAnalyticsQuery,
  type AdminAnalyticsUrlChange,
} from "@/lib/admin-url-state";
import { cn, fmtAgo, fmtNum } from "@/lib/utils";

type AnalyticsLoadError = "unauthorized" | "access_denied" | "invalid_filters" | "unavailable";

const TABS: Array<{ id: AuroraAnalyticsTab; label: string }> = [
  { id: "overview", label: "Обзор" },
  { id: "funnel", label: "Воронка" },
  { id: "errors", label: "Ошибки" },
  { id: "speed", label: "Скорость" },
  { id: "events", label: "События" },
];

const HEALTH_LABELS: Record<AuroraAnalyticsHealthState, string> = {
  healthy: "Подтверждено",
  degraded: "Есть отклонения",
  down: "Критично",
  unobserved: "Нет наблюдений",
};

function duration(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value <= 0) return "—";
  if (value < 1_000) return `${Math.round(value).toLocaleString("ru-RU")} мс`;
  return `${(value / 1_000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} с`;
}

function percent(value: number | null | undefined) {
  return value == null || !Number.isFinite(value) ? "—" : `${value.toLocaleString("ru-RU", { maximumFractionDigits: 1 })}%`;
}

function Change({ value, invert = false }: { value: number | null; invert?: boolean }) {
  if (value == null) return <span className="type-caption text-text-3">новая база</span>;
  const positive = invert ? value <= 0 : value >= 0;
  return (
    <span className={cn("type-caption font-semibold", value === 0 ? "text-text-3" : positive ? "text-success-text" : "text-danger-text") }>
      {value > 0 ? "+" : ""}{percent(value)}
    </span>
  );
}

function Metric({ label, value, format = "number", invert = false }: {
  label: string;
  value: AuroraMetricValue | AuroraNullableMetricValue;
  format?: "number" | "percent" | "duration";
  invert?: boolean;
}) {
  const rendered = format === "percent" ? percent(value.current)
    : format === "duration" ? duration(value.current)
      : value.current == null ? "—" : fmtNum(value.current);
  return (
    <div className="rounded-sm bg-surface-inset p-3.5">
      <p className="type-caption text-text-3">{label}</p>
      <div className="mt-1.5 flex items-baseline justify-between gap-3">
        <p className="nums type-body-strong text-text">{rendered}</p>
        <Change value={value.changePercent} invert={invert} />
      </div>
    </div>
  );
}

function Health({ state }: { state: AuroraAnalyticsHealthState }) {
  const Icon = state === "healthy" ? CheckCircle2 : state === "unobserved" ? Clock3 : state === "down" ? XCircle : AlertTriangle;
  return (
    <span className={cn(
      "type-caption inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-semibold",
      state === "healthy" && "bg-success-soft text-success-text",
      state === "degraded" && "bg-fire-soft text-fire-text",
      state === "down" && "bg-danger-soft text-danger-text",
      state === "unobserved" && "bg-surface-inset text-text-2",
    )}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {HEALTH_LABELS[state]}
    </span>
  );
}

function SectionCard({ section, selected, onSelect }: {
  section: AuroraAnalyticsSectionCard;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <article className={cn(
      "card-plain flex min-w-0 flex-col rounded-md border p-4 transition-[border-color,box-shadow,transform] sm:p-5",
      selected ? "border-brand shadow-card" : "border-line hover:-translate-y-0.5 hover:border-brand/35",
    )}>
      <button type="button" className="min-h-11 text-start" aria-pressed={selected} onClick={onSelect}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="type-caption text-text-3">{section.groupTitle}</p>
            <h3 className="mt-1 truncate text-text">{section.label}</h3>
          </div>
          <Health state={section.technical.state} />
        </div>
        <p className="type-caption mt-3 text-text-3">{section.technical.reason}</p>
      </button>

      <div className="mt-4 grid gap-3">
        <section aria-label="Активность" className="rounded-sm border border-line p-3.5">
          <div className="flex items-center gap-2 text-info-text"><Activity className="h-4 w-4" aria-hidden /><h4 className="type-label">Активность</h4></div>
          <dl className="mt-3 grid grid-cols-2 gap-3">
            <div><dt className="type-caption text-text-3">Пользователи</dt><dd className="nums type-body-strong mt-1 text-text">{fmtNum(section.activity.uniqueUsers.current)}</dd></div>
            <div><dt className="type-caption text-text-3">Запуски</dt><dd className="nums type-body-strong mt-1 text-text">{fmtNum(section.activity.launches.current)}</dd></div>
            <div><dt className="type-caption text-text-3">Сессии</dt><dd className="nums type-body-strong mt-1 text-text">{fmtNum(section.activity.sessions.current)}</dd></div>
            <div><dt className="type-caption text-text-3">Действия</dt><dd className="nums type-body-strong mt-1 text-text">{fmtNum(section.activity.keyActions.current)}</dd></div>
          </dl>
        </section>
        <section aria-label="Техническое здоровье" className="rounded-sm border border-line p-3.5">
          <div className="flex items-center gap-2 text-fire-text"><Gauge className="h-4 w-4" aria-hidden /><h4 className="type-label">Техническое здоровье</h4></div>
          <dl className="mt-3 grid grid-cols-3 gap-2">
            <div><dt className="type-caption text-text-3">Ошибки</dt><dd className="nums mt-1 font-semibold text-text">{percent(section.technical.errorRate.current)}</dd></div>
            <div><dt className="type-caption text-text-3">p95</dt><dd className="nums mt-1 font-semibold text-text">{duration(section.technical.p95Ms.current)}</dd></div>
            <div><dt className="type-caption text-text-3">Затронуто</dt><dd className="nums mt-1 font-semibold text-text">{fmtNum(section.technical.affectedUsers.current)}</dd></div>
          </dl>
        </section>
        <section aria-label="Полезный результат" className="rounded-sm border border-line p-3.5">
          <div className="flex items-center gap-2 text-success-text"><CheckCircle2 className="h-4 w-4" aria-hidden /><h4 className="type-label">Полезный результат</h4></div>
          <p className="type-caption mt-2 text-text-3">{section.outcome.label}</p>
          {section.outcome.coverage === "available" ? (
            <div className="mt-2 flex items-baseline justify-between gap-3">
              <p className="nums text-xl font-bold text-text">{fmtNum(section.outcome.successes.current)}</p>
              <span className="type-caption text-text-2">успешность {percent(section.outcome.successRate.current)}</span>
            </div>
          ) : (
            <p className="type-caption mt-2 rounded-xs bg-fire-soft px-2.5 py-2 text-fire-text">
              {section.outcome.coverage === "not_filterable" ? "Фильтр не подтверждается доменными данными" : "Нет подтверждённого результата"}
            </p>
          )}
        </section>
      </div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <button type="button" className="type-button min-h-11 text-brand hover:underline" onClick={onSelect}>Открыть аналитику</button>
        <Link href={section.href} className="grid h-11 w-11 place-items-center rounded-sm text-text-3 hover:bg-surface-inset hover:text-text" aria-label={`Открыть ${section.label} в приложении`}>
          <ArrowUpRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
    </article>
  );
}

function Timeline({ data }: { data: AdminAuroraAnalytics }) {
  const selected = data.filters.sectionId;
  const buckets = useMemo(() => {
    const map = new Map<string, { bucket: string; users: number; launches: number; successes: number; failures: number }>();
    for (const row of data.timeline) {
      if (selected && row.sectionId !== selected) continue;
      const current = map.get(row.bucket) ?? { bucket: row.bucket, users: 0, launches: 0, successes: 0, failures: 0 };
      current.users += row.users;
      current.launches += row.launches;
      current.successes += row.successes;
      current.failures += row.failures;
      map.set(row.bucket, current);
    }
    return [...map.values()].sort((left, right) => left.bucket.localeCompare(right.bucket));
  }, [data.timeline, selected]);
  const maximum = Math.max(1, ...buckets.map((item) => item.launches + item.successes + item.failures));
  return (
    <section className="card-plain mt-5 rounded-md p-5 sm:p-6" aria-labelledby="aurora-timeline-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 id="aurora-timeline-title" className="text-text">Динамика событий</h3>
          <p className="type-caption mt-1 text-text-3">Запуски, успешные завершения и ошибки. Пустой период остаётся пустым.</p>
        </div>
        <div className="type-caption flex flex-wrap gap-3 text-text-2" aria-label="Легенда">
          <span className="inline-flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-xs bg-brand" />Запуски</span>
          <span className="inline-flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-xs bg-success" />Успехи</span>
          <span className="inline-flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-xs bg-danger" />Ошибки</span>
        </div>
      </div>
      {data.releases.length > 0 ? (
        <div className="mt-4 flex gap-2 overflow-x-auto pb-1" aria-label="Отметки релизов">
          {data.releases.map((release) => (
            <span key={`${release.release}-${release.deployedAt}`} className="type-caption shrink-0 rounded-full border border-brand/25 bg-info-soft px-3 py-1.5 text-info-text">
              ◆ {release.release} · {new Date(release.deployedAt).toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
            </span>
          ))}
        </div>
      ) : <p className="type-caption mt-4 text-text-3">В выбранном периоде отметок развёртывания нет.</p>}
      {buckets.length === 0 ? (
        <div className="mt-5 rounded-sm bg-surface-inset p-8 text-center text-text-2">Сырые события за этот период ещё не поступали.</div>
      ) : (
        <div className="mt-5 overflow-x-auto pb-2">
          <ol className="flex h-48 min-w-max items-end gap-2" aria-label="Временной ряд событий">
            {buckets.map((item, index) => {
              const scale = 140 / maximum;
              const label = new Date(item.bucket).toLocaleString("ru-RU", data.filters.range === "24h"
                ? { hour: "2-digit", minute: "2-digit" }
                : { day: "numeric", month: "short" });
              return (
                <li key={item.bucket} className="flex w-10 shrink-0 flex-col items-center justify-end" title={`${label}: запуски ${item.launches}, успехи ${item.successes}, ошибки ${item.failures}`}>
                  <div className="flex h-36 items-end gap-0.5" aria-hidden>
                    <span className="w-2.5 rounded-t-xs bg-brand" style={{ height: Math.max(item.launches ? 4 : 1, item.launches * scale) }} />
                    <span className="w-2.5 rounded-t-xs bg-success" style={{ height: Math.max(item.successes ? 4 : 1, item.successes * scale) }} />
                    <span className="w-2.5 rounded-t-xs bg-danger" style={{ height: Math.max(item.failures ? 4 : 1, item.failures * scale) }} />
                  </div>
                  <span className="type-caption mt-2 h-4 whitespace-nowrap text-text-3">{buckets.length < 15 || index % Math.ceil(buckets.length / 10) === 0 ? label : ""}</span>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </section>
  );
}

function OverviewTab({ data, section }: { data: AdminAuroraAnalytics; section: AuroraAnalyticsSectionCard }) {
  const problems = data.problems.filter((problem) => problem.sectionId === section.id).slice(0, 8);
  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Пользователи" value={section.activity.uniqueUsers} />
        <Metric label="Сессии" value={section.activity.sessions} />
        <Metric label="Ключевые действия" value={section.activity.keyActions} />
        <Metric label="Успешность результата" value={section.outcome.successRate} format="percent" />
        <Metric label="Затронутые пользователи" value={section.technical.affectedUsers} invert />
        <Metric label="Error rate" value={section.technical.errorRate} format="percent" invert />
        <Metric label="p50" value={section.technical.p50Ms} format="duration" invert />
        <Metric label="p95" value={section.technical.p95Ms} format="duration" invert />
        <Metric label="p99" value={section.technical.p99Ms} format="duration" invert />
        <Metric label="Время до результата · p50" value={section.outcome.timeToResultP50Ms} format="duration" invert />
      </div>
      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(18rem,0.8fr)]">
        <section className="rounded-sm border border-line p-4 sm:p-5">
          <h4 className="text-text">Основные проблемы</h4>
          <p className="type-caption mt-1 text-text-3">Рейтинг строится только по прозрачной формуле impact.</p>
          {problems.length === 0 ? (
            <p className="mt-4 rounded-sm bg-surface-inset p-4 text-text-2">Подтверждённых отклонений за период нет.</p>
          ) : (
            <ol className="mt-4 space-y-3">
              {problems.map((problem) => (
                <li key={problem.id} className="rounded-sm bg-surface-inset p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div><p className="type-body-strong text-text">{problem.title}</p><p className="type-caption mt-1 text-text-3">{problem.evidence}</p></div>
                    <span className="nums rounded-full bg-danger-soft px-2.5 py-1 text-sm font-semibold text-danger-text">{fmtNum(problem.impact)}</span>
                  </div>
                  <p className="type-caption mt-2 font-mono text-text-3">impact = {problem.formula}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {problem.dependencyId ? <Link href={`/admin?system=${problem.dependencyId}#system`} className={buttonClassName({ variant: "secondary", size: "sm" })}>Открыть зависимость</Link> : null}
                    {problem.sentryUrl ? <a href={problem.sentryUrl} target="_blank" rel="noreferrer" className={buttonClassName({ variant: "secondary", size: "sm" })}>Sentry <ExternalLink className="h-3.5 w-3.5" aria-hidden /></a> : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
        <section className="rounded-sm border border-line p-4 sm:p-5">
          <h4 className="text-text">Сценарий и подтверждение</h4>
          <ol className="mt-4 space-y-2">
            {data.detail?.scenario.map((action, index) => (
              <li key={action} className="flex items-center gap-3 text-text-2"><span className="nums grid h-7 w-7 shrink-0 place-items-center rounded-full bg-info-soft text-info-text">{index + 1}</span><code className="break-all text-sm">{action}</code></li>
            ))}
          </ol>
          <div className="mt-5 rounded-sm bg-success-soft p-4">
            <p className="type-label text-success-text">Доменный результат</p>
            <p className="type-secondary mt-2 text-text">{section.outcome.label}</p>
            <p className="type-caption mt-1 text-text-2">{section.outcome.reason ?? `Последний успех: ${section.outcome.lastSuccessAt ? fmtAgo(section.outcome.lastSuccessAt) : "нет"}`}</p>
          </div>
          {data.releases.length > 0 ? (
            <div className="mt-4">
              <p className="type-label text-text-3">Релизы в периоде</p>
              <ul className="mt-2 space-y-2">
                {data.releases.map((release) => <li key={release.release} className="type-caption rounded-sm bg-surface-inset p-2.5 text-text-2">{release.release}{release.commitSha ? ` · ${release.commitSha.slice(0, 12)}` : ""}</li>)}
              </ul>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function FunnelTab({ data }: { data: AdminAuroraAnalytics }) {
  const funnel = data.detail?.funnel ?? [];
  return (
    <div className="overflow-x-auto rounded-sm border border-line">
      <table className="w-full min-w-[920px] text-start">
        <thead className="bg-surface-2"><tr><th className="px-4 py-3 text-start">Шаг</th><th className="px-4 py-3 text-start">Источник</th><th className="px-4 py-3 text-start">Пользователи</th><th className="px-4 py-3 text-start">Конверсия</th><th className="px-4 py-3 text-start">Потери</th><th className="px-4 py-3 text-start">p50</th><th className="px-4 py-3 text-start">Ошибки</th><th className="px-4 py-3 text-start">Изменение</th></tr></thead>
        <tbody className="divide-y divide-line">
          {funnel.map((step, index) => (
            <tr key={step.id}>
              <td className="px-4 py-4"><div className="flex items-center gap-3"><span className="nums grid h-8 w-8 shrink-0 place-items-center rounded-full bg-info-soft text-info-text">{index + 1}</span><span className="type-body-strong text-text">{step.label}</span></div></td>
              <td className="px-4 py-4 text-text-2">{step.evidence === "domain_table" ? "доменная таблица" : step.evidence === "combined" ? "события + домен" : "product event"}</td>
              <td className="nums px-4 py-4 text-text">{fmtNum(step.users.current)}</td>
              <td className="nums px-4 py-4 text-text">{percent(step.conversionPercent)}</td>
              <td className={cn("nums px-4 py-4", step.dropoffUsers != null && step.dropoffUsers > 0 ? "text-danger-text" : "text-text-2")}>{step.dropoffUsers == null ? "—" : fmtNum(step.dropoffUsers)}</td>
              <td className="nums px-4 py-4 text-text-2">{duration(step.durationP50Ms)}</td>
              <td className="nums px-4 py-4 text-text-2">{fmtNum(step.errors)}</td>
              <td className="px-4 py-4"><Change value={step.users.changePercent} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {funnel.length === 0 ? <p className="p-6 text-center text-text-2">Событий воронки за период нет.</p> : null}
    </div>
  );
}

function ErrorDetail({ error }: { error: AuroraAnalyticsErrorGroup }) {
  const [copied, setCopied] = useState(false);
  return (
    <details className="rounded-sm border border-line bg-surface">
      <summary className="cursor-pointer list-none p-4 marker:hidden">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div><p className="type-body-strong text-text">{error.title}</p><p className="type-caption mt-1 font-mono text-text-3">{error.errorCode} · {error.featureId} · {error.stage}</p></div>
          <div className="flex items-center gap-2"><span className="nums rounded-full bg-danger-soft px-2.5 py-1 text-sm font-semibold text-danger-text">{fmtNum(error.count)}</span><span className="type-caption rounded-full bg-surface-inset px-2.5 py-1 text-text-2">{error.status}</span></div>
        </div>
      </summary>
      <div className="border-t border-line p-4">
        <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div><dt className="type-caption text-text-3">Источник</dt><dd className="mt-1 text-text">{error.source}</dd></div>
          <div><dt className="type-caption text-text-3">Пользователи / проекты</dt><dd className="nums mt-1 text-text">{fmtNum(error.affectedUsers)} / {fmtNum(error.affectedProjects)}</dd></div>
          <div><dt className="type-caption text-text-3">Первое появление</dt><dd className="mt-1 text-text">{new Date(error.firstSeenAt).toLocaleString("ru-RU")}</dd></div>
          <div><dt className="type-caption text-text-3">Последнее появление</dt><dd className="mt-1 text-text">{new Date(error.lastSeenAt).toLocaleString("ru-RU")}</dd></div>
          <div><dt className="type-caption text-text-3">Релиз</dt><dd className="mt-1 text-text">{error.release ?? "Не определён"}</dd></div>
          <div><dt className="type-caption text-text-3">Предыдущий период</dt><dd className="nums mt-1 text-text">{fmtNum(error.previousCount)}</dd></div>
          <div className="sm:col-span-2"><dt className="type-caption text-text-3">Request ID</dt><dd className="mt-1 break-all font-mono text-sm text-text">{error.requestId ?? "Нет корреляции"}</dd></div>
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          {error.requestId ? <Button variant="secondary" size="sm" onClick={() => void navigator.clipboard.writeText(error.requestId ?? "").then(() => setCopied(true))}><Copy className="h-3.5 w-3.5" aria-hidden />{copied ? "Скопировано" : "Копировать request ID"}</Button> : null}
          {error.dependencyId ? <Link href={`/admin?system=${error.dependencyId}#system`} className={buttonClassName({ variant: "secondary", size: "sm" })}>Открыть зависимость</Link> : null}
          {error.sentryUrl ? <a href={error.sentryUrl} target="_blank" rel="noreferrer" className={buttonClassName({ variant: "secondary", size: "sm" })}>Открыть в Sentry <ExternalLink className="h-3.5 w-3.5" aria-hidden /></a> : null}
        </div>
      </div>
    </details>
  );
}

function ErrorsTab({ data }: { data: AdminAuroraAnalytics }) {
  const errors = data.detail?.errors ?? [];
  if (errors.length === 0) return <div className="rounded-sm bg-surface-inset p-8 text-center text-text-2">Безопасных кодов ошибок за период нет.</div>;
  return <div className="space-y-3">{errors.map((error) => <ErrorDetail key={`${error.errorCode}-${error.featureId}-${error.stage}-${error.source}`} error={error} />)}</div>;
}

function SpeedTab({ data }: { data: AdminAuroraAnalytics }) {
  const speed = data.detail?.speed ?? [];
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2">
        {data.detail?.slos.map((slo) => <span key={`${slo.kind}-${slo.operation}`} className="type-caption rounded-full bg-info-soft px-3 py-1.5 text-info-text">{slo.kind}: p95 ≤ {duration(slo.p95Ms)}</span>)}
      </div>
      <div className="overflow-x-auto rounded-sm border border-line">
        <table className="w-full min-w-[900px] text-start">
          <thead className="bg-surface-2"><tr><th className="px-4 py-3 text-start">Операция</th><th className="px-4 py-3 text-start">Источник</th><th className="px-4 py-3 text-start">Релиз</th><th className="px-4 py-3 text-start">Наблюдения</th><th className="px-4 py-3 text-start">p50</th><th className="px-4 py-3 text-start">p95</th><th className="px-4 py-3 text-start">p99</th><th className="px-4 py-3 text-start">SLO</th></tr></thead>
          <tbody className="divide-y divide-line">
            {speed.map((row, index) => (
              <tr key={`${row.source}-${row.operationKind}-${row.release}-${index}`}>
                <td className="px-4 py-4 font-mono text-sm text-text">{row.operationKind}</td><td className="px-4 py-4 text-text-2">{row.source}</td><td className="px-4 py-4 text-text-2">{row.release ?? "—"}</td><td className="nums px-4 py-4 text-text-2">{fmtNum(row.observations)}</td><td className="nums px-4 py-4 text-text-2">{duration(row.p50Ms)}</td><td className="nums px-4 py-4 text-text">{duration(row.p95Ms)}</td><td className="nums px-4 py-4 text-text-2">{duration(row.p99Ms)}</td>
                <td className="px-4 py-4">{row.withinSlo == null ? <span className="text-text-3">Не сопоставлено</span> : row.withinSlo ? <span className="text-success-text">В пределах · {duration(row.sloP95Ms)}</span> : <span className="text-danger-text">Превышено · {duration(row.sloP95Ms)}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {speed.length === 0 ? <p className="p-6 text-center text-text-2">Измерений длительности за период нет.</p> : null}
      </div>
    </div>
  );
}

function EventsTab({ data }: { data: AdminAuroraAnalytics }) {
  const events = data.detail?.events ?? [];
  if (events.length === 0) return <div className="rounded-sm bg-surface-inset p-8 text-center text-text-2">Безопасных событий за период нет.</div>;
  return (
    <ol className="relative space-y-3 before:absolute before:inset-y-3 before:left-[1.05rem] before:w-px before:bg-line">
      {events.map((event) => (
        <li key={event.id} className="relative flex gap-4">
          <span className={cn("z-10 mt-4 h-3 w-3 shrink-0 rounded-full ring-4 ring-surface", event.outcome === "failure" ? "bg-danger" : event.outcome === "success" ? "bg-success" : "bg-brand")} />
          <article className="min-w-0 flex-1 rounded-sm border border-line bg-surface p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div><p className="type-body-strong text-text">{event.action} · {event.stage}</p><p className="type-caption mt-1 font-mono text-text-3">{event.featureId} · {event.source}{event.operationKind ? ` · ${event.operationKind}` : ""}</p></div>
              <time className="type-caption shrink-0 text-text-3" dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString("ru-RU")}</time>
            </div>
            <div className="type-caption mt-3 flex flex-wrap gap-x-4 gap-y-2 text-text-2">
              <span>{event.userRef}</span><span>{event.projectRef}</span><span>{event.device}</span><span>{event.release ?? "релиз не определён"}</span><span>{duration(event.durationMs)}</span>{event.errorCode ? <span className="font-mono text-danger-text">{event.errorCode}</span> : null}
            </div>
            {event.requestId ? <div className="mt-3 flex items-center gap-2"><code className="min-w-0 truncate text-xs text-text-3">{event.requestId}</code><button type="button" className="grid h-9 w-9 shrink-0 place-items-center rounded-sm hover:bg-surface-inset" onClick={() => void navigator.clipboard.writeText(event.requestId ?? "")} aria-label="Копировать request ID"><Copy className="h-3.5 w-3.5" aria-hidden /></button></div> : null}
          </article>
        </li>
      ))}
    </ol>
  );
}

function ProblemsList({ data, onOpen }: { data: AdminAuroraAnalytics; onOpen: (sectionId: AuroraAnalyticsSectionCard["id"]) => void }) {
  const problems = data.problems.slice(0, 8);
  return (
    <section className="card-plain mt-5 rounded-md p-5" aria-labelledby="aurora-problems-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 id="aurora-problems-title" className="text-text">Проблемы за период</h3>
          <p className="type-caption mt-1 text-text-3">Рейтинг impact = пользователи × частота × серьёзность, по всем разделам.</p>
        </div>
        <span className="type-caption text-text-3">{fmtNum(data.problems.length)} всего</span>
      </div>
      {problems.length === 0 ? (
        <p className="mt-4 rounded-sm bg-success-soft p-4 text-success-text">Подтверждённых отклонений за период нет.</p>
      ) : (
        <ol className="mt-4 divide-y divide-line">
          {problems.map((problem) => (
            <li key={problem.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="type-secondary font-semibold text-text">{problem.title}</p>
                <p className="type-caption mt-0.5 text-text-3">{problem.evidence}</p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <span className="nums rounded-full bg-danger-soft px-2.5 py-1 text-sm font-semibold text-danger-text" title={`impact = ${problem.formula}`}>{fmtNum(problem.impact)}</span>
                <button type="button" onClick={() => onOpen(problem.sectionId)} className={buttonClassName({ variant: "secondary", size: "sm" })}>Открыть раздел</button>
                {problem.dependencyId ? <Link href={`/admin?system=${problem.dependencyId}#system`} className={buttonClassName({ variant: "ghost", size: "sm" })}>Зависимость</Link> : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function SectionCards({ data, selectedId, onSelect }: {
  data: AdminAuroraAnalytics;
  selectedId: string | null;
  onSelect: (sectionId: AuroraAnalyticsSectionCard["id"]) => void;
}) {
  const groups = [...new Set(data.sections.map((section) => section.groupId))];
  return (
    <>
      {groups.map((groupId) => {
        const sections = data.sections.filter((section) => section.groupId === groupId);
        return (
          <div key={groupId} className="mt-5">
            <h4 className="type-label text-text-2">{sections[0]?.groupTitle}</h4>
            <div className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {sections.map((section) => <SectionCard key={section.id} section={section} selected={selectedId === section.id} onSelect={() => onSelect(section.id)} />)}
            </div>
          </div>
        );
      })}
    </>
  );
}

function SectionsTable({ data, selectedId, onSelect }: {
  data: AdminAuroraAnalytics;
  selectedId: string | null;
  onSelect: (sectionId: AuroraAnalyticsSectionCard["id"]) => void;
}) {
  return (
    <div className="mt-4 overflow-x-auto rounded-md border border-line bg-surface shadow-soft">
      <table className="w-full min-w-[880px] text-start">
        <thead className="bg-surface-2">
          <tr className="type-caption text-text-3">
            <th className="px-3 py-2 text-start font-semibold">Раздел</th>
            <th className="px-3 py-2 text-start font-semibold">Здоровье</th>
            <th className="px-3 py-2 text-end font-semibold">Пользователи</th>
            <th className="px-3 py-2 text-end font-semibold">Запуски</th>
            <th className="px-3 py-2 text-end font-semibold">Error rate</th>
            <th className="px-3 py-2 text-end font-semibold">p95</th>
            <th className="px-3 py-2 text-end font-semibold">Результат</th>
            <th className="px-3 py-2 text-end font-semibold">Тренд</th>
            <th className="px-3 py-2" aria-label="Действие" />
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {data.sections.map((section) => (
            <tr key={section.id} className={cn("align-middle transition-colors hover:bg-surface-2/60", selectedId === section.id && "bg-info-soft/40")}>
              <td className="px-3 py-2">
                <p className="type-secondary font-semibold text-text">{section.label}</p>
                <p className="type-caption text-text-3">{section.groupTitle}</p>
              </td>
              <td className="px-3 py-2"><Health state={section.technical.state} /></td>
              <td className="nums px-3 py-2 text-end text-text">{fmtNum(section.activity.uniqueUsers.current)}</td>
              <td className="nums px-3 py-2 text-end text-text-2">{fmtNum(section.activity.launches.current)}</td>
              <td className={cn("nums px-3 py-2 text-end", section.technical.errorRate.current > 5 ? "text-danger-text" : "text-text-2")}>{percent(section.technical.errorRate.current)}</td>
              <td className="nums px-3 py-2 text-end text-text-2">{duration(section.technical.p95Ms.current)}</td>
              <td className="nums px-3 py-2 text-end text-text-2">
                {section.outcome.coverage === "available" ? `${fmtNum(section.outcome.successes.current)} · ${percent(section.outcome.successRate.current)}` : <span className="text-text-3">нет данных</span>}
              </td>
              <td className="px-3 py-2 text-end"><Change value={section.activity.uniqueUsers.changePercent} /></td>
              <td className="px-3 py-2 text-end"><button type="button" onClick={() => onSelect(section.id)} className={buttonClassName({ variant: "secondary", size: "sm" })}>Открыть</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DetailPanel({ data, onTab }: { data: AdminAuroraAnalytics; onTab: (tab: AuroraAnalyticsTab) => void }) {
  const section = data.sections.find((candidate) => candidate.id === data.detail?.sectionId);
  if (!section || !data.detail) return null;
  return (
    <section className="card-plain rounded-lg border border-brand/25 p-4 shadow-card sm:p-6" aria-labelledby="aurora-detail-title">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div><Health state={section.technical.state} /><h3 id="aurora-detail-title" className="mt-3 text-text">{section.label}</h3><p className="type-secondary mt-2 text-text-2">Активность, технические сигналы и доменный результат показаны раздельно.</p></div>
        <Link href={section.href} className={buttonClassName({ variant: "secondary" })}>Открыть раздел <ArrowUpRight className="h-4 w-4" aria-hidden /></Link>
      </div>
      <nav className="mt-5 overflow-x-auto border-b border-line" aria-label="Детали аналитики раздела">
        <div className="flex min-w-max gap-1">
          {TABS.map((tab) => <button key={tab.id} type="button" aria-current={data.detail?.tab === tab.id ? "page" : undefined} onClick={() => onTab(tab.id)} className={cn("type-button min-h-11 border-b-2 px-4", data.detail?.tab === tab.id ? "border-brand text-brand" : "border-transparent text-text-2 hover:text-text")}>{tab.label}</button>)}
        </div>
      </nav>
      <div className="mt-5">
        {data.detail.tab === "overview" ? <OverviewTab data={data} section={section} /> : null}
        {data.detail.tab === "funnel" ? <FunnelTab data={data} /> : null}
        {data.detail.tab === "errors" ? <ErrorsTab data={data} /> : null}
        {data.detail.tab === "speed" ? <SpeedTab data={data} /> : null}
        {data.detail.tab === "events" ? <EventsTab data={data} /> : null}
      </div>
    </section>
  );
}

export function AdminAuroraAnalyticsCenter() {
  const detailRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [data, setData] = useState<AdminAuroraAnalytics | null>(null);
  const [error, setError] = useState<AnalyticsLoadError | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  useEffect(() => {
    const syncUrl = () => {
      const params = adminAnalyticsQuery(window.location.search);
      setRefreshing(true);
      setQuery(params.toString());
      setCustomFrom(params.get("from") ?? "");
      setCustomTo(params.get("to") ?? "");
      setRefreshKey((value) => value + 1);
    };
    const initialSync = window.setTimeout(syncUrl, 0);
    window.addEventListener("popstate", syncUrl);
    return () => {
      window.clearTimeout(initialSync);
      window.removeEventListener("popstate", syncUrl);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const suffix = query ? `?${query}` : "";
    void fetch(`/api/admin/aurora-analytics${suffix}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) throw new Error("unauthorized");
        if (response.status === 403) throw new Error("access_denied");
        if (response.status === 422) throw new Error("invalid_filters");
        if (!response.ok) throw new Error("unavailable");
        return response.json() as Promise<AdminAuroraAnalytics>;
      })
      .then((payload) => { setData(payload); setError(null); })
      .catch((loadError) => {
        if (controller.signal.aborted) return;
        const message = loadError instanceof Error ? loadError.message : "unavailable";
        setError(message === "unauthorized" || message === "access_denied" || message === "invalid_filters" ? message : "unavailable");
      })
      .finally(() => { if (!controller.signal.aborted) setRefreshing(false); });
    return () => controller.abort();
  }, [query, refreshKey]);

  const navigate = (changes: AdminAnalyticsUrlChange, scrollToDetail = false) => {
    const href = adminAnalyticsHref(window.location.href, changes);
    window.history.pushState({}, "", href);
    const nextParams = adminAnalyticsQuery(window.location.search);
    setRefreshing(true);
    setQuery(nextParams.toString());
    setCustomFrom(nextParams.get("from") ?? "");
    setCustomTo(nextParams.get("to") ?? "");
    setRefreshKey((value) => value + 1);
    if (scrollToDetail) window.requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const requestRefresh = () => {
    setRefreshing(true);
    setRefreshKey((value) => value + 1);
  };

  const params = useMemo(() => new URLSearchParams(query), [query]);
  const selectedId = data?.filters.sectionId ?? null;
  const view = params.get("analyticsView") === "cards" ? "cards" : "table";
  const selectSection = (sectionId: AuroraAnalyticsSectionCard["id"]) => {
    navigate({ analyticsSection: sectionId, analyticsTab: selectedId === sectionId ? data?.filters.tab ?? "overview" : "overview" }, true);
  };

  if (!data && !error) {
    return <div className="mt-6" aria-busy="true"><div className="skeleton h-28 rounded-md" /><div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 9 }, (_, index) => <div key={index} className="skeleton h-96 rounded-md" />)}</div><p className="sr-only" role="status">Загружаем аналитику разделов…</p></div>;
  }

  if (!data) {
    return (
      <div className="mt-6 rounded-md border border-danger/20 bg-danger-soft p-6">
        <h3 className="text-text">Аналитика недоступна</h3>
        <p className="type-secondary mt-2 text-text-2">{error === "unauthorized" ? "Нужна действующая сессия администратора." : error === "access_denied" ? "У сессии нет глобального доступа администратора." : error === "invalid_filters" ? "Параметры фильтра в URL недопустимы." : "Не удалось получить подтверждённые события и доменные результаты."}</p>
        <Button className="mt-4" variant="secondary" onClick={requestRefresh}>Повторить</Button>
      </div>
    );
  }

  return (
    <div className="mt-6">
      <section className="card-plain rounded-md p-4 sm:p-5" aria-label="Фильтры аналитики Авроры">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="type-label text-brand">Исторические данные</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {[{ id: "24h", label: "24 часа" }, { id: "7d", label: "7 дней" }, { id: "30d", label: "30 дней" }, { id: "custom", label: "Свой период" }].map((range) => (
                <button key={range.id} type="button" aria-pressed={data.filters.range === range.id} onClick={() => navigate({ range: range.id, ...(range.id === "custom" ? {} : { from: null, to: null }) })} className={cn("type-button min-h-11 rounded-sm px-3.5 whitespace-nowrap", data.filters.range === range.id ? "bg-brand text-white shadow-soft" : "border border-line text-text-2 hover:bg-surface-inset")}>{range.label}</button>
              ))}
            </div>
          </div>
          <Button variant="secondary" loading={refreshing} onClick={requestRefresh}><RefreshCw className="h-4 w-4" aria-hidden />Обновить</Button>
        </div>
        {data.filters.range === "custom" ? (
          <div className="mt-4 flex flex-col gap-3 rounded-sm bg-surface-inset p-3 sm:flex-row sm:items-end">
            <label className="type-caption text-text-2">С даты<input type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} className="mt-1 block min-h-11 rounded-sm border border-line bg-surface px-3 text-text" /></label>
            <label className="type-caption text-text-2">По дату<input type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} className="mt-1 block min-h-11 rounded-sm border border-line bg-surface px-3 text-text" /></label>
            <Button variant="secondary" disabled={!customFrom || !customTo} onClick={() => navigate({ range: "custom", from: customFrom, to: customTo })}>Применить период</Button>
          </div>
        ) : null}
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <label className="type-caption text-text-3">Проект<select aria-label="Проект" value={params.get("project") ?? "all"} onChange={(event) => navigate({ project: event.target.value })} className="mt-1 block min-h-11 w-full rounded-sm border border-line bg-surface px-3 text-text"><option value="all">Все проекты</option>{data.options.projects.map((project) => <option key={project.id} value={project.id}>{project.label}</option>)}</select></label>
          <label className="type-caption text-text-3">Сегмент<select aria-label="Сегмент" value={params.get("segment") ?? "all"} onChange={(event) => navigate({ segment: event.target.value })} className="mt-1 block min-h-11 w-full rounded-sm border border-line bg-surface px-3 text-text"><option value="all">Все роли</option><option value="owners">Владельцы</option><option value="team">Команда</option></select></label>
          <label className="type-caption text-text-3">Пользователи<select aria-label="Пользователи" value={params.get("tenure") ?? "all"} onChange={(event) => navigate({ tenure: event.target.value })} className="mt-1 block min-h-11 w-full rounded-sm border border-line bg-surface px-3 text-text"><option value="all">Все</option><option value="new">Новые</option><option value="returning">Повторные</option></select></label>
          <label className="type-caption text-text-3">Устройство<select aria-label="Устройство" value={params.get("device") ?? "all"} onChange={(event) => navigate({ device: event.target.value })} className="mt-1 block min-h-11 w-full rounded-sm border border-line bg-surface px-3 text-text"><option value="all">Все</option><option value="desktop">Desktop</option><option value="mobile">Mobile</option><option value="tablet">Tablet</option><option value="unknown">Не определено</option></select></label>
          <label className="type-caption text-text-3">Версия<select aria-label="Версия" value={params.get("version") ?? "all"} onChange={(event) => navigate({ version: event.target.value })} className="mt-1 block min-h-11 w-full rounded-sm border border-line bg-surface px-3 text-text"><option value="all">Все версии</option>{data.options.appVersions.map((version) => <option key={version} value={version}>{version}</option>)}</select></label>
          <label className="type-caption text-text-3">Релиз<select aria-label="Релиз" value={params.get("release") ?? "all"} onChange={(event) => navigate({ release: event.target.value })} className="mt-1 block min-h-11 w-full rounded-sm border border-line bg-surface px-3 text-text"><option value="all">Все релизы</option>{data.options.releases.map((release) => <option key={release} value={release}>{release}</option>)}</select></label>
        </div>
      </section>

      {error ? <p role="alert" className="mt-4 rounded-sm bg-danger-soft p-4 text-danger-text">Обновление не удалось. Показан последний подтверждённый снимок.</p> : null}

      <ProblemsList data={data} onOpen={(sectionId) => navigate({ analyticsSection: sectionId, analyticsTab: "errors" }, true)} />

      <section className="mt-6" aria-labelledby="aurora-sections-title">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div><h3 id="aurora-sections-title" className="text-text">Все разделы Авроры</h3><p className="type-caption mt-1 text-text-3">{data.sections.length} разделов из APP_ROUTES · проверено {fmtAgo(data.checkedAt)} · данные не подменяются оценками.</p></div>
          <div className="inline-flex rounded-sm border border-line bg-surface p-1" role="group" aria-label="Вид списка разделов">
            {([["table", "Таблица"], ["cards", "Карточки"]] as const).map(([id, label]) => (
              <button key={id} type="button" aria-pressed={view === id} onClick={() => navigate({ analyticsView: id === "table" ? null : id })} className={cn("type-button min-h-9 rounded-xs px-3", view === id ? "bg-brand text-white shadow-soft" : "text-text-2 hover:bg-surface-inset hover:text-text")}>{label}</button>
            ))}
          </div>
        </div>
        {view === "table" ? (
          <SectionsTable data={data} selectedId={selectedId} onSelect={selectSection} />
        ) : <SectionCards data={data} selectedId={selectedId} onSelect={selectSection} />}
      </section>

      <Timeline data={data} />

      <div ref={detailRef} className="scroll-mt-20 pt-8">
        {data.detail ? <DetailPanel data={data} onTab={(tab) => navigate({ analyticsTab: tab }, true)} /> : (
          <div className="rounded-md border border-dashed border-line p-8 text-center"><BarChart3 className="mx-auto h-9 w-9 text-brand" aria-hidden /><h3 className="mt-3 text-text">Выберите раздел</h3><p className="type-secondary mt-2 text-text-2">Откроются обзор, воронка, безопасные ошибки, скорость и хронология событий.</p></div>
        )}
      </div>

      <aside className="mt-5 rounded-sm bg-surface-inset p-4">
        <p className="type-label text-text-2">Покрытие данных</p>
        <ul className="type-caption mt-2 space-y-1 text-text-3">{data.coverage.notes.map((note) => <li key={note}>• {note}</li>)}</ul>
      </aside>
    </div>
  );
}
