"use client";

import { checkAdminAccess, CopyValue, SnapshotNote } from "./admin-ui";

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
import { adminSystemMetricLabel, adminSectionLabel, formatAdminDuration, formatAdminMetric } from "@/lib/admin-labels";
import { diagnosticDisplayState, isSystemDiagnostics } from "@/lib/admin-system-freshness";
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
  down: "Ошибка",
  unavailable: "Проверка недоступна",
  stale: "Данные устарели",
  not_used: "Не используется",
  unobserved: "Работа не подтверждена",
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
        (state === "degraded" || state === "unobserved" || state === "not_configured" || state === "stale" || state === "unavailable") && "bg-fire-soft text-fire-text",
        (state === "configured" || state === "not_used") && "bg-surface-inset text-text-2",
      )}
      title={state === "configured" ? "Проверена только конфигурация, а не работа в рантайме" : undefined}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {STATE_LABELS[state]}
    </span>
  );
}

const SYSTEM_DESCRIPTION: Record<string, string> = {
  publication_worker: "Обработчик отправляет посты из очереди. Проверяем его последний сигнал работы и результаты отправки.",
  telegram_worker: "Получение сообщений ботом и наличие работающего обработчика.",
  aurora_ai: "Результаты реальных AI-попыток и состояние защиты от повторных ошибок.",
  media_generation: "Очередь создания медиа и результаты завершённых задач.",
  site_analysis: "Очередь анализа сайтов и этапы обработки.",
  token_encryption: "Доступность ключей для чтения сохранённых подключений.",
  tracking_secrets: "Наличие и корректность секретов отслеживания.",
  upload_limits: "Ограничения размера загружаемых файлов и запросов.",
  https_origin: "Защищённый адрес сайта, с которого разрешены административные изменения.",
  database_schema: "Версия базы и наличие необходимых таблиц и полей.",
  redis: "Доступность очередей, память и время работы сервиса.",
};
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
      <h3 className="text-text">Очереди</h3>
      <p className="type-caption mt-2 max-w-2xl text-text-2">Счётчики показывают записи, сохранённые BullMQ сейчас. Завершённые и неуспешные задачи — история с ограниченным хранением, без фиксированного периода. Consumer без свежего выполнения не подтверждает исправность. Возраст ожидания — по выборке до 100 задач каждого состояния; будущие отложенные задачи исключены.</p>
      <div className="mt-3 overflow-x-auto rounded-sm border border-line" role="region" aria-label="Состояние очередей" tabIndex={0}>
        <table className="w-full min-w-[780px] text-start">
          <thead className="bg-surface-2">
            <tr>
              <th className="px-4 py-3 text-start">Очередь</th>
              <th className="px-4 py-3 text-start">Состояние</th>
              <th className="px-4 py-3 text-start">Обработчики</th>
              <th className="px-4 py-3 text-start">Ожидают</th>
              <th className="px-4 py-3 text-start">В работе</th>
              <th className="px-4 py-3 text-start">Отложены</th>
              <th className="px-4 py-3 text-start">Приоритетные / ждут дочерние</th>
              <th className="px-4 py-3 text-start">Завершены, сохранено</th>
              <th className="px-4 py-3 text-start">Ошибки, сохранено</th>
              <th className="px-4 py-3 text-start">Возраст ожидания, выборка</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {queues.map((queue) => (
              <tr key={queue.name}>
                <td className="px-4 py-3 font-mono text-sm text-text">{queue.name}{queue.safeErrorCode ? <p className="type-caption break-all">{queue.safeErrorCode}</p> : null}<p className="type-caption">Выполнение: {queue.lastCompletedAt ? fmtAgo(queue.lastCompletedAt) : "не подтверждено"}</p></td>
                <td className="px-4 py-3"><DiagnosticStatus state={queue.state} /></td>
                <td className="nums px-4 py-3 text-text-2">{queue.workers ?? "—"}</td>
                <td className="nums px-4 py-3 text-text-2">{queue.waiting ?? "—"}</td>
                <td className="nums px-4 py-3 text-text-2">{queue.active ?? "—"}</td>
                <td className="nums px-4 py-3 text-text-2">{queue.delayed ?? "—"}</td>
                <td className="nums px-4 py-3 text-text-2">{queue.prioritized ?? "—"} / {queue.waitingChildren ?? "—"}</td>
                <td className="nums px-4 py-3 text-text-2">{queue.completed ?? "—"}</td>
                <td className="nums px-4 py-3 text-text-2">{queue.failed ?? "—"}</td>
                <td className="px-4 py-3 text-text-2">{duration(queue.oldestJobAgeMs)}<p className="type-caption">Выборка: {queue.sampledJobs ?? "—"}</p>{queue.unmeasuredWaitingJobs ? <p className="type-caption">У {queue.unmeasuredWaitingJobs} повторных задач нет точного времени начала ожидания.</p> : null}</td>
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
          <h3 className="text-text">Защита от повторных ошибок</h3>
          <p className="type-caption mt-2 text-text-2">Только текущий web-процесс, счётчики с его запуска.</p>
          <ul className="mt-3 space-y-3">
            {providers.map((item, index) => {
              const provider = item as Record<string, unknown>;
              return (
                <li key={String(provider.engine || index)} className="rounded-sm bg-surface-inset p-3">
                  <p className="type-body-strong text-text">{String(provider.engine || "provider")}</p>
                  <p className="type-caption mt-1 text-text-3">
                    {String(provider.state || "unknown")} · {fmtNum(Number(provider.successes || 0))} успешно · {fmtNum(Number(provider.failures || 0))} с ошибкой
                  </p>
                  <p className="type-caption mt-1 text-text-3">Время ответа: {duration(provider.lastLatencyMs == null ? null : Number(provider.lastLatencyMs))}</p>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {activeModels.length > 0 ? (
        <div className="rounded-sm border border-line p-4">
          <h3 className="text-text">История AI-маршрутов за 30 дней</h3>
          <ul className="mt-3 space-y-3">
            {activeModels.map((item, index) => {
              const model = item as Record<string, unknown>;
              return (
                <li key={`${String(model.provider)}-${String(model.model)}-${index}`} className="rounded-sm bg-surface-inset p-3">
                  {model.state ? <DiagnosticStatus state={model.state as AdminDiagnosticState} /> : null}
                  <p className="type-body-strong text-text">{String(model.provider || "provider")} · {String(model.model || "model")}</p>
                  <p className="type-caption mt-1 text-text-3">
                    {fmtNum(Number(model.successes || 0))} успешно · {fmtNum(Number(model.failures || 0))} с ошибкой · среднее {duration(model.averageLatencyMs == null ? null : Number(model.averageLatencyMs))}
                  </p>
                  {model.lastFailureAt ? <p className="type-caption mt-2 text-text-2">Ошибки в периоде: с {formatEvidence("Дата", String(model.firstFailureAt || model.lastFailureAt))} по {formatEvidence("Дата", String(model.lastFailureAt))}. Последний код: {String(model.lastErrorCode || "provider_error")}.</p> : null}
                  {model.lastSuccessAt ? <p className="type-caption mt-1 text-text-2">Последний успех: {formatEvidence("Дата", String(model.lastSuccessAt))}</p> : null}
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
          <h2 id="system-detail-title" className="mt-3 text-text">{component.label}</h2>
          <p className="type-secondary mt-2 text-text-2">{SYSTEM_DESCRIPTION[component.id] || component.description}</p>
        </div>
        <div className="type-caption shrink-0 text-text-3 sm:text-end">
          <p>Проверено: <time dateTime={component.checkedAt}>{fmtAgo(component.checkedAt)}</time></p>
          <p className="mt-1">Длительность: {duration(component.durationMs)}</p>
        </div>
      </div>

      {component.state !== "healthy" && component.state !== "configured" && component.state !== "not_used" ? <p className="type-secondary mt-5 rounded-sm border border-fire/25 bg-fire-soft p-4 text-text-2">{component.state === "stale" ? "Срок действия проверки истёк. Снимок сохранён для сравнения; обновите данные, чтобы узнать текущее состояние." : component.state === "unavailable" ? "Диагностика не завершилась. Этот снимок не подтверждает работоспособность сервиса. Повторите проверку кнопкой «Обновить»; если ошибка остаётся, передайте код диагностики ответственному за инфраструктуру." : component.id === "publication_worker" ? "Отправка новых публикаций может быть задержана. Проверьте очередь и проблемные публикации. При неподтверждённой доставке сначала сверьте результат у провайдера: повторная отправка может создать дубликат." : "Успешная работа сервиса не подтверждена. Проверьте сведения ниже и обновите проверку после устранения причины."}</p> : null}
      {component.scope ? <p className="type-secondary mt-4 max-w-2xl text-text-2">{component.scope}</p> : null}
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
          <details><summary className="type-caption">Код диагностики</summary>{component.safeErrorCode ? <CopyValue value={component.safeErrorCode} label="код диагностики сервиса" /> : <p className="type-caption text-text-3">Текущий код отсутствует. Это не подтверждает отсутствие исторических ошибок.</p>}</details>
        </div>
      </div>

      {primitiveMetrics.length > 0 ? (
        <div className="mt-6">
          <h3 className="text-text">Метрики</h3>
          <dl className="mt-3 grid gap-x-6 gap-y-3 rounded-sm border border-line p-4 sm:grid-cols-2 xl:grid-cols-3">
            {primitiveMetrics.map(([key, value]) => (
              <div key={key} className="flex items-baseline justify-between gap-4 border-b border-line/70 pb-2">
                <dt className="type-caption break-words text-text-3" title={key}>{adminSystemMetricLabel(component.id, key)}</dt>
                <dd className="nums type-secondary text-end font-semibold text-text">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {reasons.length > 0 ? (
        <div className="mt-6 rounded-sm border border-fire/20 bg-fire-soft p-4">
          <h3 className="text-text">Несовпадения схемы</h3>
          <ul className="mt-3 space-y-1 font-mono text-sm text-fire-text">
            {reasons.map((reason, index) => <li key={`${String(reason)}-${index}`}>{String(reason)}</li>)}
          </ul>
        </div>
      ) : null}

      <ProviderTables component={component} />
      {component.history ? <section className="mt-6" aria-labelledby="system-error-history">
        <h3 id="system-error-history" className="text-text">История ошибок публикаций за 24 часа</h3>
        <p className="type-caption mt-2 max-w-2xl text-text-2">События сохраняются после восстановления. Количество событий включает повторы; оно не равно числу уникальных публикаций. Отсутствие событий не подтверждает исправность.</p>
        {component.history.length ? <ul className="mt-3 space-y-3">{component.history.map(item => <li key={item.code} className="rounded-sm bg-surface-inset p-4">
          <CopyValue value={item.code} label="код исторической ошибки" />
          <p className="type-secondary mt-2 text-text">Событий: {item.count} · Записей, требующих внимания сейчас: {item.affectedRecords}</p>
          <p className="type-caption mt-1 text-text-2">Первое в периоде: {formatEvidence("Дата", item.firstSeenAt)} · Последнее: {formatEvidence("Дата", item.lastSeenAt)}</p>
          <p className="type-caption mt-1 text-text-2">{item.affectedRecords ? "Проверьте текущее состояние публикаций по идентификаторам ниже." : "В связанных записях не найдены состояния отказа, повтора или неподтверждённой доставки. Само событие не доказывает текущий сбой."}</p>
          {item.examples.length ? <p className="type-caption mt-2 break-words font-mono text-text-2">{item.examples.join(", ")}</p> : null}
        </li>)}</ul> : <p className="type-secondary mt-3 text-text-2">Записанных событий ошибок за этот период нет.</p>}
      </section> : null}
      <QueueTable queues={component.queues ?? []} />

      {component.affectedSections && component.affectedSections.length > 0 ? (
        <div className="mt-6">
          <h3 className="text-text">Затронутые разделы</h3>
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
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const displayed = useMemo(() => data?.components.map(component => {
    const state = diagnosticDisplayState(component, now, Boolean(error));
    const invalid = state !== component.state && (state === "stale" || state === "unavailable");
    return { ...component, state, queues: invalid ? component.queues?.map(queue => ({ ...queue, state })) : component.queues,
      metrics: invalid && Array.isArray(component.metrics?.activeModels) ? { ...component.metrics,
        activeModels: component.metrics.activeModels.map(model => ({ ...(model as Record<string, unknown>), state })) } : component.metrics };
  }) ?? [], [data, now, error]);
  // An old execution outcome can be observed by a fresh check. Only expired check
  // timestamps make the snapshot itself stale; the component keeps its own state.
  const stale = data?.components.some(component =>
    diagnosticDisplayState({ ...component, state: "healthy" }, now) === "stale") ?? false;
  const [autoRefresh, setAutoRefresh] = useState<AutoRefresh>(0);
  const requestRefresh = useCallback(() => {
    setRefreshing(true);
    setRefreshKey((value) => value + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setError("unavailable"); setRefreshing(false); controller.abort();
    }, 15_000);
    void fetch("/api/admin/system", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        checkAdminAccess(response);
        if (response.status === 401) throw new Error("unauthorized");
        if (response.status === 403) throw new Error("access_denied");
        if (!response.ok) throw new Error("unavailable");
        const payload: unknown = await response.json();
        if (!isSystemDiagnostics(payload)) throw new Error("unavailable");
        return payload;
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setNow(Date.now());
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
        window.clearTimeout(timeout);
        if (!controller.signal.aborted) setRefreshing(false);
      });
    return () => { window.clearTimeout(timeout); controller.abort(); };
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

  const selected = displayed.find((component) => component.id === selectedId) ?? null;

  const select = (componentId: string) => {
    const next = selectedId === componentId ? null : componentId;
    window.history.pushState({}, "", adminSystemHref(window.location.href, next));
    setSelectedId(next);
    if (next) {
      window.requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" }));
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
        <Button className="mt-4" variant="secondary" onClick={requestRefresh}>Повторить попытку</Button>
      </div>
    );
  }

  return (
    <div className="mt-6">
      <section className={cn(
        "rounded-lg border p-5 shadow-soft sm:p-6",
        stale || error ? "border-line bg-surface" : data.state === "healthy" ? "border-success/20 bg-success-soft"
          : data.state === "down" ? "border-danger/20 bg-danger-soft" : "border-fire/25 bg-fire-soft",
      )} aria-labelledby="system-platform-state">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <DiagnosticStatus state={error ? "unavailable" : stale ? "stale" : data.state} />
            <h2 id="system-platform-state" className="mt-3 text-text">
              {stale || error ? "Состояние требует новой проверки" : data.state === "healthy" ? "Платформа подтверждена"
                : data.state === "down" ? "Есть критические зависимости" : data.state === "unobserved" ? "Исправность подтверждена не полностью" : "Обнаружены отклонения"}
            </h2>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-text-2">
              <span className="type-secondary">Исправно: <strong className="nums text-text">{displayed.filter(component => component.state === "healthy").length}</strong></span>
              <span className="type-secondary" title="Проверена только конфигурация">Настроено: <strong className="nums text-text">{displayed.filter(component => component.state === "configured").length}</strong></span>
              <span className="type-secondary">Предупреждения: <strong className="nums text-text">{displayed.filter(component => ["degraded", "unobserved", "not_configured", "unavailable", "stale"].includes(component.state)).length}</strong></span>
              <span className="type-secondary">Критические: <strong className="nums text-text">{displayed.filter(component => ["down", "conflict"].includes(component.state)).length}</strong></span>
              <span className="type-secondary">Не используется: <strong className="nums text-text">{displayed.filter(component => component.state === "not_used").length}</strong></span>
            </div>
            <div className="mt-3"><SnapshotNote checkedAt={data.checkedAt} failed={Boolean(error)} busy={refreshing} onRefresh={requestRefresh} /></div>
            <p className="type-caption mt-1 text-text-3">
              Среда: {data.environment || "не установлена"} · режим сервера: {data.runtimeMode || "не установлен"} · сборка браузера: {process.env.NEXT_PUBLIC_AURORA_APP_VERSION || "не установлена"}
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
        const components = displayed.filter((component) => component.group === group.id);
        return (
          <section key={group.id} className="mt-8" aria-labelledby={`system-group-${group.id}`}>
            <h2 id={`system-group-${group.id}`} className="text-text">{group.label}</h2>
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
                      "card-plain min-h-40 rounded-md p-5 text-start transition-[border-color,background-color,box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:border-brand/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand active:scale-[0.96] motion-reduce:transform-none",
                      active && "border-brand bg-info-soft shadow-md ring-1 ring-brand/25",
                    )}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <Icon className="h-6 w-6 text-brand" strokeWidth={1.8} aria-hidden />
                      <DiagnosticStatus state={component.state} />
                    </div>
                    <h3 className="mt-4 text-text">{component.label}</h3>
                    <p className="type-caption mt-2 text-text-2">Проверка: {formatEvidence("Дата", component.checkedAt)}</p>
                    <p className="type-caption mt-1 text-text-3">{SYSTEM_DESCRIPTION[component.id] || component.description}</p>
                    <p className="type-caption mt-3 text-text-3">
                      {component.lastSuccessAt ? `Последний успех: ${fmtAgo(component.lastSuccessAt)}` : "Выполнение ещё не подтверждено"}
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
