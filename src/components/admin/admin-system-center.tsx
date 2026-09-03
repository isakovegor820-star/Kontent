"use client";

import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock3,
  Database,
  Gauge,
  HardDrive,
  KeyRound,
  Mail,
  Radio,
  RefreshCw,
  Server,
  ShieldCheck,
  Upload,
  XCircle,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button, buttonClassName } from "@/components/ui/button";
import type {
  AdminDiagnosticComponent,
  AdminDiagnosticState,
  AdminQueueSnapshot,
  AdminSystemDiagnostics,
} from "@/lib/admin-system-diagnostics";
import { adminMetricLabel, adminSectionLabel, formatAdminDuration, formatAdminMetric } from "@/lib/admin-labels";
import { adminSystemHref, adminSystemSelection } from "@/lib/admin-url-state";
import { cn, fmtAgo, fmtNum } from "@/lib/utils";

type AutoRefresh = 0 | 30_000 | 60_000;
type SystemLoadError = "unauthorized" | "access_denied" | "unavailable";

const GROUPS = [
  { id: "core", label: "Ядро" },
  { id: "integrations", label: "Интеграции и процессы" },
  { id: "security", label: "Безопасность" },
] as const;

const ICONS: Record<string, LucideIcon> = {
  web_api: Activity,
  postgresql: Database,
  database_schema: HardDrive,
  redis: Radio,
  publication_worker: Server,
  telegram_worker: Bot,
  aurora_ai: Zap,
  media_generation: Gauge,
  site_analysis: Activity,
  mail_delivery: Mail,
  token_encryption: KeyRound,
  tracking_secrets: ShieldCheck,
  upload_limits: Upload,
  https_origin: ShieldCheck,
  current_release: Server,
};

const STATE_LABELS: Record<AdminDiagnosticState, string> = {
  healthy: "Исправно",
  degraded: "Есть отклонения",
  down: "Недоступно",
  unobserved: "Нет наблюдения",
  not_configured: "Не настроено",
  configured: "Настроено",
  conflict: "Конфликт",
};

function DiagnosticStatus({ state }: { state: AdminDiagnosticState }) {
  const Icon = state === "healthy" ? CheckCircle2
    : state === "down" || state === "conflict" ? XCircle
      : state === "degraded" ? AlertTriangle
        : state === "configured" ? ShieldCheck : Clock3;
  return (
    <span
      className={cn(
        "type-caption inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-semibold",
        state === "healthy" && "bg-success-soft text-success-text",
        (state === "down" || state === "conflict") && "bg-danger-soft text-danger-text",
        (state === "degraded" || state === "unobserved" || state === "not_configured") && "bg-fire-soft text-fire-text",
        state === "configured" && "bg-surface-inset text-text-2",
      )}
      title={state === "configured" ? "Проверена только конфигурация, а не работа в рантайме" : undefined}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {STATE_LABELS[state]}
    </span>
  );
}

const duration = formatAdminDuration;

/** Evidence arrives as raw numbers/ISO strings; the label tells which unit applies. */
function formatEvidence(label: string, value: string | number | boolean | null): string {
  if (value == null || value === "") return "Нет подтверждения";
  if (typeof value === "number") {
    if (/память|memory/iu.test(label)) return formatAdminMetric("bytes", value) ?? String(value);
    if (/uptime/iu.test(label)) return formatAdminMetric("seconds", value) ?? String(value);
    if (/возраст|интервал|задержка|длительность/iu.test(label)) return formatAdminDuration(value);
    return fmtNum(value);
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/u.test(value) && Number.isFinite(Date.parse(value))) {
    return `${new Date(value).toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" })} · ${fmtAgo(value)}`;
  }
  return String(value);
}

function QueueTable({ queues }: { queues: readonly AdminQueueSnapshot[] }) {
  if (queues.length === 0) return null;
  return (
    <div className="mt-6">
      <h4 className="text-text">Очереди</h4>
      <div className="mt-3 overflow-x-auto rounded-sm border border-line">
        <table className="w-full min-w-[780px] text-start">
          <thead className="bg-surface-2">
            <tr>
              <th className="px-4 py-3 text-start">Очередь</th>
              <th className="px-4 py-3 text-start">Состояние</th>
              <th className="px-4 py-3 text-start">Workers</th>
              <th className="px-4 py-3 text-start">Waiting</th>
              <th className="px-4 py-3 text-start">Active</th>
              <th className="px-4 py-3 text-start">Delayed</th>
              <th className="px-4 py-3 text-start">Completed</th>
              <th className="px-4 py-3 text-start">Failed</th>
              <th className="px-4 py-3 text-start">Старейшая</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {queues.map((queue) => (
              <tr key={queue.name}>
                <td className="px-4 py-3 font-mono text-sm text-text">{queue.name}</td>
                <td className="px-4 py-3"><DiagnosticStatus state={queue.state} /></td>
                <td className="nums px-4 py-3 text-text-2">{queue.workers ?? "—"}</td>
                <td className="nums px-4 py-3 text-text-2">{queue.waiting ?? "—"}</td>
                <td className="nums px-4 py-3 text-text-2">{queue.active ?? "—"}</td>
                <td className="nums px-4 py-3 text-text-2">{queue.delayed ?? "—"}</td>
                <td className="nums px-4 py-3 text-text-2">{queue.completed ?? "—"}</td>
                <td className="nums px-4 py-3 text-text-2">{queue.failed ?? "—"}</td>
                <td className="px-4 py-3 text-text-2">{duration(queue.oldestJobAgeMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProviderTables({ component }: { component: AdminDiagnosticComponent }) {
  const providers = Array.isArray(component.metrics?.providers) ? component.metrics.providers : [];
  const activeModels = Array.isArray(component.metrics?.activeModels) ? component.metrics.activeModels : [];
  if (providers.length === 0 && activeModels.length === 0) return null;
  return (
    <div className="mt-6 grid gap-4 xl:grid-cols-2">
      {providers.length > 0 ? (
        <div className="rounded-sm border border-line p-4">
          <h4 className="text-text">Circuit state</h4>
          <ul className="mt-3 space-y-3">
            {providers.map((item, index) => {
              const provider = item as Record<string, unknown>;
              return (
                <li key={String(provider.engine || index)} className="rounded-sm bg-surface-inset p-3">
                  <p className="type-body-strong text-text">{String(provider.engine || "provider")}</p>
                  <p className="type-caption mt-1 text-text-3">
                    {String(provider.state || "unknown")} · {fmtNum(Number(provider.successes || 0))} success · {fmtNum(Number(provider.failures || 0))} failure
                  </p>
                  <p className="type-caption mt-1 text-text-3">Latency: {duration(provider.lastLatencyMs == null ? null : Number(provider.lastLatencyMs))}</p>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {activeModels.length > 0 ? (
        <div className="rounded-sm border border-line p-4">
          <h4 className="text-text">Активные модели</h4>
          <ul className="mt-3 space-y-3">
            {activeModels.map((item, index) => {
              const model = item as Record<string, unknown>;
              return (
                <li key={`${String(model.provider)}-${String(model.model)}-${index}`} className="rounded-sm bg-surface-inset p-3">
                  <p className="type-body-strong text-text">{String(model.provider || "provider")} · {String(model.model || "model")}</p>
                  <p className="type-caption mt-1 text-text-3">
                    {fmtNum(Number(model.successes || 0))} success · {fmtNum(Number(model.failures || 0))} failure · avg {duration(model.averageLatencyMs == null ? null : Number(model.averageLatencyMs))}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ComponentDetails({ component }: { component: AdminDiagnosticComponent }) {
  const primitiveMetrics = Object.entries(component.metrics ?? {})
    .map(([key, value]) => [key, formatAdminMetric(key, value)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null);
  const reasons = Array.isArray(component.metrics?.reasons) ? component.metrics.reasons : [];
  return (
    <article aria-labelledby="system-detail-title">
      <div className="flex flex-col gap-4 border-b border-line pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <DiagnosticStatus state={component.state} />
          <h3 id="system-detail-title" className="mt-3 text-text">{component.label}</h3>
          <p className="type-secondary mt-2 text-text-2">{component.description}</p>
        </div>
        <div className="type-caption shrink-0 text-text-3 sm:text-end">
          <p>Проверено: <time dateTime={component.checkedAt}>{fmtAgo(component.checkedAt)}</time></p>
          <p className="mt-1">Длительность: {duration(component.durationMs)}</p>
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {component.evidence.map((item, index) => (
          <div key={`${item.label}-${index}`} className="rounded-sm bg-surface-inset p-4">
            <p className="type-label text-text-3">{item.label}</p>
            <p className={cn(
              "type-secondary mt-2 break-words font-semibold",
              item.tone === "critical" ? "text-danger-text" : item.tone === "warning" ? "text-fire-text" : "text-text",
            )}>{formatEvidence(item.label, item.value)}</p>
          </div>
        ))}
        <div className="rounded-sm bg-surface-inset p-4">
          <p className="type-label text-text-3">Последний успех</p>
          <p className="type-secondary mt-2 font-semibold text-text">
            {component.lastSuccessAt ? <time dateTime={component.lastSuccessAt}>{fmtAgo(component.lastSuccessAt)}</time> : "Нет подтверждения"}
          </p>
        </div>
        <div className="rounded-sm bg-surface-inset p-4">
          <p className="type-label text-text-3">Безопасный код ошибки</p>
          <p className="type-secondary mt-2 break-all font-mono font-semibold text-text">{component.safeErrorCode || "—"}</p>
        </div>
      </div>

      {primitiveMetrics.length > 0 ? (
        <div className="mt-6">
          <h4 className="text-text">Метрики</h4>
          <dl className="mt-3 grid gap-x-6 gap-y-3 rounded-sm border border-line p-4 sm:grid-cols-2 xl:grid-cols-3">
            {primitiveMetrics.map(([key, value]) => (
              <div key={key} className="flex items-baseline justify-between gap-4 border-b border-line/70 pb-2">
                <dt className="type-caption break-words text-text-3" title={key}>{adminMetricLabel(key)}</dt>
                <dd className="nums type-secondary text-end font-semibold text-text">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {reasons.length > 0 ? (
        <div className="mt-6 rounded-sm border border-fire/20 bg-fire-soft p-4">
          <h4 className="text-text">Несовпадения схемы</h4>
          <ul className="mt-3 space-y-1 font-mono text-sm text-fire-text">
            {reasons.map((reason, index) => <li key={`${String(reason)}-${index}`}>{String(reason)}</li>)}
          </ul>
        </div>
      ) : null}

      <ProviderTables component={component} />
      <QueueTable queues={component.queues ?? []} />

      {component.affectedSections && component.affectedSections.length > 0 ? (
        <div className="mt-6">
          <h4 className="text-text">Затронутые разделы</h4>
          <div className="mt-3 flex flex-wrap gap-2">
            {component.affectedSections.map((section) => (
              <Link prefetch={false} key={section} href={`/admin?analyticsSection=${section}#aurora-analytics`} className={buttonClassName({ variant: "secondary", size: "sm" })}>
                {adminSectionLabel(section)}
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      {component.links && component.links.length > 0 ? (
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {component.links.map((link) => (
            <Link prefetch={false} key={link.href} href={link.href} className={buttonClassName({ variant: "secondary" })}>{link.label}</Link>
          ))}
        </div>
      ) : null}
    </article>
  );
}

export function AdminSystemCenter() {
  const detailRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<AdminSystemDiagnostics | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<SystemLoadError | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState<AutoRefresh>(0);
  const requestRefresh = useCallback(() => {
    setRefreshing(true);
    setRefreshKey((value) => value + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/admin/system", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) throw new Error("unauthorized");
        if (response.status === 403) throw new Error("access_denied");
        if (!response.ok) throw new Error("unavailable");
        return response.json() as Promise<AdminSystemDiagnostics>;
      })
      .then((payload) => {
        setData(payload);
        setSelectedId(adminSystemSelection(
          window.location.search,
          payload.components.map((component) => component.id),
        ));
        setError(null);
      })
      .catch((loadError) => {
        if (controller.signal.aborted) return;
        const message = loadError instanceof Error ? loadError.message : "unavailable";
        setError(message === "unauthorized" || message === "access_denied" ? message : "unavailable");
      })
      .finally(() => {
        if (!controller.signal.aborted) setRefreshing(false);
      });
    return () => controller.abort();
  }, [refreshKey]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(requestRefresh, autoRefresh);
    return () => window.clearInterval(timer);
  }, [autoRefresh, requestRefresh]);

  const componentIds = useMemo(() => data?.components.map((component) => component.id) ?? [], [data]);
  const syncSelection = useCallback(() => {
    setSelectedId(adminSystemSelection(window.location.search, componentIds));
  }, [componentIds]);

  useEffect(() => {
    window.addEventListener("popstate", syncSelection);
    return () => window.removeEventListener("popstate", syncSelection);
  }, [syncSelection]);

  const selected = data?.components.find((component) => component.id === selectedId) ?? null;

  const select = (componentId: string) => {
    const next = selectedId === componentId ? null : componentId;
    window.history.pushState({}, "", adminSystemHref(window.location.href, next));
    setSelectedId(next);
    if (next) {
      window.requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  };

  if (!data && !error) {
    return (
      <div className="mt-6" aria-busy="true">
        <div className="skeleton h-36 rounded-md" />
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }, (_, index) => <div key={index} className="skeleton h-40 rounded-md" />)}
        </div>
        <p role="status" className="sr-only">Проверяем компоненты платформы…</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mt-6 rounded-md border border-danger/20 bg-danger-soft p-6">
        <h3 className="text-text">Диагностика недоступна</h3>
        <p className="type-secondary mt-2 text-text-2">
          {error === "unauthorized" ? "Нужна действующая сессия администратора."
            : error === "access_denied" ? "У этой сессии нет глобального доступа администратора."
              : "Не удалось получить безопасный снимок компонентов."}
        </p>
        <Button className="mt-4" variant="secondary" onClick={requestRefresh}>Повторить</Button>
      </div>
    );
  }

  return (
    <div className="mt-6">
      <section className={cn(
        "rounded-lg border p-5 shadow-soft sm:p-6",
        data.state === "healthy" ? "border-success/20 bg-success-soft"
          : data.state === "down" ? "border-danger/20 bg-danger-soft" : "border-fire/25 bg-fire-soft",
      )} aria-labelledby="system-platform-state">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <DiagnosticStatus state={data.state} />
            <h3 id="system-platform-state" className="mt-3 text-text">
              {data.state === "healthy" ? "Платформа подтверждена"
                : data.state === "down" ? "Есть критические зависимости" : "Платформа работает с отклонениями"}
            </h3>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-text-2">
              <span className="type-secondary">Исправно: <strong className="nums text-text">{data.summary.healthy}</strong></span>
              <span className="type-secondary" title="Проверена только конфигурация">Настроено: <strong className="nums text-text">{data.summary.configured}</strong></span>
              <span className="type-secondary">Предупреждения: <strong className="nums text-text">{data.summary.warnings}</strong></span>
              <span className="type-secondary">Критические: <strong className="nums text-text">{data.summary.critical}</strong></span>
            </div>
            <p className="type-caption mt-3 text-text-3">
              Последняя проверка: <time dateTime={data.checkedAt}>{fmtAgo(data.checkedAt)}</time> · {duration(data.durationMs)}
            </p>
            <p className="type-caption mt-1 text-text-3">
              Релиз: {data.release.release || "не настроен"} · commit <span className="font-mono" title={data.release.commitSha ?? undefined}>{data.release.commitSha ? data.release.commitSha.slice(0, 12) : "—"}</span> · развёрнут {data.release.deployedAt ? fmtAgo(data.release.deployedAt) : "—"}
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="type-caption text-text-3">
              Автообновление
              <select
                className="mt-1.5 min-h-11 rounded-sm border border-line bg-surface px-3 text-text"
                value={autoRefresh}
                onChange={(event) => setAutoRefresh(Number(event.target.value) as AutoRefresh)}
              >
                <option value={0}>Выключено</option>
                <option value={30_000}>30 секунд</option>
                <option value={60_000}>1 минута</option>
              </select>
            </label>
            <Button
              variant="secondary"
              loading={refreshing}
              onClick={requestRefresh}
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              Обновить
            </Button>
          </div>
        </div>
      </section>

      {error ? (
        <p role="alert" className="mt-4 rounded-sm bg-danger-soft p-4 text-danger-text">
          Обновление не завершено. Показан последний подтверждённый снимок.
        </p>
      ) : null}

      {GROUPS.map((group) => {
        const components = data.components.filter((component) => component.group === group.id);
        return (
          <section key={group.id} className="mt-8" aria-labelledby={`system-group-${group.id}`}>
            <h3 id={`system-group-${group.id}`} className="text-text">{group.label}</h3>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {components.map((component) => {
                const Icon = ICONS[component.id] ?? Server;
                const active = component.id === selectedId;
                return (
                  <button
                    key={component.id}
                    type="button"
                    aria-expanded={active}
                    aria-controls="system-component-detail"
                    onClick={() => select(component.id)}
                    className={cn(
                      "card-plain min-h-40 rounded-md p-5 text-start transition-[border-color,background-color,box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:border-brand/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand active:scale-[0.99] motion-reduce:transform-none",
                      active && "border-brand bg-info-soft shadow-md ring-1 ring-brand/25",
                    )}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <Icon className="h-6 w-6 text-brand" strokeWidth={1.8} aria-hidden />
                      <DiagnosticStatus state={component.state} />
                    </div>
                    <h4 className="mt-4 text-text">{component.label}</h4>
                    <p className="type-caption mt-1 text-text-3">{component.description}</p>
                    <p className="type-caption mt-3 text-text-3">
                      {component.lastSuccessAt ? `Успех ${fmtAgo(component.lastSuccessAt)}` : "Успех ещё не подтверждён"}
                    </p>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}

      <div ref={detailRef} id="system-component-detail" className="scroll-mt-20 pt-8" aria-live="polite">
        {selected ? (
          <div className="card-plain rounded-lg p-5 sm:p-7">
            <ComponentDetails component={selected} />
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-line bg-surface-2 p-6 text-center sm:p-9">
            <Server className="mx-auto h-8 w-8 text-brand" aria-hidden />
            <h3 className="mt-3 text-text">Выберите компонент</h3>
            <p className="type-secondary mx-auto mt-2 max-w-xl text-text-2">Здесь откроются основание статуса, метрики, очереди и безопасные переходы.</p>
          </div>
        )}
      </div>
    </div>
  );
}
