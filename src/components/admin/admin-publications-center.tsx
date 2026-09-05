"use client";

import { checkAdminAccess } from "./admin-ui";

import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  RefreshCw,
  Search,
  ShieldAlert,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { FormEvent, useEffect, useId, useRef, useState } from "react";

import { adminJson, CopyValue, ReadError, SnapshotNote, useSnapshotAge } from "./admin-ui";
import { useModalFocus } from "@/components/ui/use-modal-focus";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type {
  AdminPublicationItem,
  AdminPublicationsResponse,
  AdminPublicationStatusFilter,
} from "@/lib/admin-publications";
import {
  adminPublicationsApiParams,
  adminPublicationsHref,
  adminPublicationsQuery,
  adminUsersHref,
  type AdminPublicationsUrlChange,
  type AdminPublicationsUrlKey,
} from "@/lib/admin-url-state";
import { cn, fmtAgo, fmtNum, NETWORK_LABEL, plural } from "@/lib/utils";

type ListState = "loading" | "ready" | "error";
type PendingAction = { kind: "retry" | "cancel" | "reschedule"; item: AdminPublicationItem } | null;

const STATUS_OPTIONS: Array<{ value: AdminPublicationStatusFilter; label: string }> = [
  { value: "attention", label: "Требуют внимания" },
  { value: "all", label: "Все публикации" },
  { value: "failed", label: "Ошибка отправки" },
  { value: "quarantined", label: "Карантин" },
  { value: "overdue", label: "Задержка очереди" },
  { value: "failed_retry", label: "Ждут повтора" },
  { value: "scheduled", label: "Запланированы" },
  { value: "publishing", label: "Публикуются" },
  { value: "published_unverified", label: "Не подтверждены сетью" },
  { value: "published", label: "Опубликованы" },
  { value: "cancelled", label: "Отменены" },
];

const SORT_OPTIONS = [
  { value: "recent", label: "Сначала свежие" },
  { value: "scheduled_asc", label: "По дате публикации" },
  { value: "attempts_desc", label: "По числу попыток" },
] as const;

const POST_STATUS_LABEL: Record<string, string> = {
  draft: "Черновик",
  scheduled: "Запланирован",
  publishing: "Публикуется",
  published_unverified: "Опубликован, проверка ожидается",
  published: "Опубликован",
  missing: "Не найден в соцсети",
  deleted_external: "Удалён в соцсети",
  failed_retry: "Ждёт повтора",
  quarantined: "Карантин",
  failed: "Ошибка отправки",
  cancelled: "Отменён",
};

const ATTENTION_LABEL: Record<NonNullable<AdminPublicationItem["attention"]>, string> = {
  failed: "Ошибка отправки",
  quarantined: "Карантин",
  overdue: "Задержка очереди",
  auth: "Нужна авторизация канала",
};

const ORIGIN_LABEL: Record<string, string> = {
  manual: "вручную",
  ai: "с AI",
  rss: "из RSS",
  trend: "из трендов",
  idea: "из идеи",
  competitor: "из разведки",
  autopilot: "автопилот",
  studio: "из Студии",
  retry: "повтор",
  legacy: "ранняя версия",
};

function numberLabel(value: number, one: string, few: string, many: string) {
  return `${fmtNum(value)} ${plural(value, one, few, many)}`;
}

function fullDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function statusTone(item: AdminPublicationItem): { tone: "success" | "danger" | "warning" | "neutral" | "brand"; icon: LucideIcon; label: string } {
  if (item.attention === "auth") return { tone: "danger", icon: ShieldAlert, label: ATTENTION_LABEL.auth };
  if (item.attention === "failed") return { tone: "danger", icon: XCircle, label: ATTENTION_LABEL.failed };
  if (item.attention === "quarantined") return { tone: "warning", icon: AlertTriangle, label: ATTENTION_LABEL.quarantined };
  if (item.attention === "overdue") return { tone: "warning", icon: Clock3, label: ATTENTION_LABEL.overdue };
  if (item.status === "published") return { tone: "success", icon: CheckCircle2, label: POST_STATUS_LABEL.published };
  if (item.status === "published_unverified" || item.status === "failed_retry") return { tone: "warning", icon: AlertTriangle, label: POST_STATUS_LABEL[item.status] };
  if (item.status === "scheduled" || item.status === "publishing") return { tone: "brand", icon: Clock3, label: POST_STATUS_LABEL[item.status] };
  return { tone: "neutral", icon: Clock3, label: POST_STATUS_LABEL[item.status] ?? item.status };
}

function StatusPill({ tone, icon: Icon, label }: ReturnType<typeof statusTone>) {
  return (
    <span className={cn(
      "type-caption inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 font-semibold whitespace-nowrap",
      tone === "success" && "bg-success-soft text-success-text",
      tone === "danger" && "bg-danger-soft text-danger-text",
      tone === "warning" && "bg-fire-soft text-fire-text",
      tone === "brand" && "bg-info-soft text-info-text",
      tone === "neutral" && "bg-surface-inset text-text-2",
    )}>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {label}
    </span>
  );
}

function SummaryChip({ label, value, active, tone, onClick }: {
  label: string;
  value: number;
  active: boolean;
  tone: "danger" | "warning" | "brand" | "neutral";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "type-label inline-flex min-h-9 items-center gap-2 rounded-full border px-3 py-1.5 transition-[border-color,background-color] duration-150",
        tone === "danger" && "bg-danger-soft text-danger-text",
        tone === "warning" && "bg-fire-soft text-fire-text",
        tone === "brand" && "bg-info-soft text-info-text",
        tone === "neutral" && "bg-surface-inset text-text-2",
        active ? "border-brand ring-1 ring-brand/30" : "border-transparent hover:border-line-strong",
      )}
    >
      {label} · <span className="nums">{fmtNum(value)}</span>
    </button>
  );
}

function defaultRescheduleValue() {
  const date = new Date(Date.now() + 10 * 60_000);
  date.setSeconds(0, 0);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const ACTION_ERROR_COPY: Record<string, string> = {
  not_found: "Публикация больше не существует.",
  in_progress: "Публикация сейчас отправляется в сеть — дождитесь результата.",
  not_allowed: "Для текущего статуса это действие недоступно. Обновите список.",
  invalid_time: "Укажите время не раньше текущего и не дальше года.",
  queue_unavailable: "Очередь публикаций недоступна. Проверьте Redis в разделе «Система».",
  forbidden_origin: "Запрос отклонён по origin. Обновите страницу.",
  unauthorized: "Сессия истекла. Войдите снова.",
  access_denied: "У сессии нет прав администратора.",
};

export function AdminPublicationsCenter({ refreshKey = 0 }: { refreshKey?: number }) {
  const [state, setState] = useState<Record<AdminPublicationsUrlKey, string> | null>(null);
  const [input, setInput] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const [data, setData] = useState<AdminPublicationsResponse | null>(null);
  const [settled, setSettled] = useState<{ key: string; ok: boolean } | null>(null);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);
  const [rescheduleValue, setRescheduleValue] = useState(defaultRescheduleValue);
  const searchId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const stale = useSnapshotAge(data?.checkedAt);
  const { overlayRef, dialogRef, onKeyDown } = useModalFocus<HTMLFormElement>({ open: pending?.kind === "reschedule", initialFocusRef: cancelRef, onEscape: () => setPending(null), busy: Boolean(actionKey) });

  const apiQuery = state ? adminPublicationsApiParams(state).toString() : null;
  const listKey = `${apiQuery}:${refreshKey}:${retryKey}`;
  const listState: ListState = !apiQuery || settled?.key !== listKey ? "loading" : settled.ok ? "ready" : "error";

  useEffect(() => {
    const sync = () => {
      const next = adminPublicationsQuery(window.location.search);
      setState(next);
      setInput(next.pq);
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  useEffect(() => {
    if (!apiQuery) return;
    const controller = new AbortController();
    void fetch(`/api/admin/publications?${apiQuery}`, { cache: "no-store", signal: controller.signal })
      .then(adminJson<AdminPublicationsResponse>)
      .then((payload) => {
        if (controller.signal.aborted) return;
        setData(payload);
        setSettled({ key: listKey, ok: true });
      })
      .catch(() => {
        if (!controller.signal.aborted) { setData(null); setSettled({ key: listKey, ok: false }); }
      });
    return () => controller.abort();
  }, [apiQuery, listKey]);

  function navigate(changes: AdminPublicationsUrlChange) {
    const href = adminPublicationsHref(window.location.href, changes);
    window.history.pushState({}, "", href);
    const next = adminPublicationsQuery(window.location.search);
    setState(next);
    setInput(next.pq);
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate({ pq: input.trim(), ppage: 1 });
  }

  async function performAction(item: AdminPublicationItem, payload: Record<string, unknown>, key: string, successText: string) {
    setActionKey(key);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/publications/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ postId: item.id, ...payload }),
      });
      checkAdminAccess(response);
      const result = await response.json().catch(() => null) as { status?: string; error?: string } | null;
      if (!response.ok) {
        const code = result?.status ?? result?.error ?? "unavailable";
        throw new Error(ACTION_ERROR_COPY[code] ?? "Не удалось подтвердить результат. Обновите список и проверьте журнал перед повтором.");
      }
      setMessage({ tone: "success", text: successText });
      setRetryKey((value) => value + 1);
      return true;
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Не удалось подтвердить результат. Проверьте состояние публикации." });
      return false;
    } finally {
      setActionKey(null);
    }
  }

  const hasActiveFilters = state && (state.pq || state.pstatus !== "all" || state.pnetwork !== "all" || state.pproject || state.perror);

  return (
    <div className="min-w-0 max-w-full">
      {data ? (
        <div className="flex flex-wrap gap-2" aria-label="Сводка статусов публикаций">
          <SummaryChip label="Требуют внимания" value={data.summary.attention} tone="danger" active={state?.pstatus === "attention"} onClick={() => navigate({ pstatus: "attention", perror: null, ppage: 1 })} />
          <SummaryChip label="Ошибка" value={data.summary.failed} tone="danger" active={state?.pstatus === "failed"} onClick={() => navigate({ pstatus: "failed", ppage: 1 })} />
          <SummaryChip label="Карантин" value={data.summary.quarantined} tone="warning" active={state?.pstatus === "quarantined"} onClick={() => navigate({ pstatus: "quarantined", ppage: 1 })} />
          <SummaryChip label="Задержка" value={data.summary.overdue} tone="warning" active={state?.pstatus === "overdue"} onClick={() => navigate({ pstatus: "overdue", ppage: 1 })} />
          <SummaryChip label="Ждут повтора" value={data.summary.failedRetry} tone="warning" active={state?.pstatus === "failed_retry"} onClick={() => navigate({ pstatus: "failed_retry", ppage: 1 })} />
          <SummaryChip label="Запланировано" value={data.summary.scheduled} tone="brand" active={state?.pstatus === "scheduled"} onClick={() => navigate({ pstatus: "scheduled", ppage: 1 })} />
          <SummaryChip label="Не подтверждены" value={data.summary.publishedUnverified} tone="warning" active={state?.pstatus === "published_unverified"} onClick={() => navigate({ pstatus: "published_unverified", ppage: 1 })} />
          <SummaryChip label="Сегодня вышло" value={data.summary.publishedToday} tone="neutral" active={state?.pstatus === "published"} onClick={() => navigate({ pstatus: "published", ppage: 1 })} />
          <SummaryChip label="Всего" value={data.summary.total} tone="neutral" active={state?.pstatus === "all"} onClick={() => navigate({ pstatus: "all", ppage: 1 })} />
        </div>
      ) : null}

      <div className="mt-5 rounded-md border border-line bg-surface p-4 shadow-soft sm:p-5">
        <form onSubmit={submitSearch} className="grid gap-4 lg:grid-cols-2 lg:items-end 2xl:grid-cols-[minmax(16rem,1fr)_13rem_11rem_13rem_13rem_auto]">
          <label htmlFor={searchId} className="block">
            <span className="type-caption mb-1.5 block text-text-3">Поиск публикации</span>
            <span className="relative block">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-text-3" aria-hidden />
              <input
                id={searchId}
                type="search"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="ID, текст, проект, канал или автор"
                className="min-h-11 w-full rounded-xs border border-line-strong bg-surface px-3.5 pl-10 text-base text-text outline-none transition-[border-color,box-shadow] placeholder:text-text-3 focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/20 sm:text-sm"
              />
            </span>
          </label>
          <label className="block">
            <span className="type-caption mb-1.5 block text-text-3">Состояние</span>
            <select value={state?.pstatus ?? "attention"} onChange={(event) => navigate({ pstatus: event.target.value, ppage: 1 })} className="min-h-11 w-full rounded-xs border border-line-strong bg-surface px-3.5 text-base text-text sm:text-sm">
              {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="type-caption mb-1.5 block text-text-3">Соцсеть</span>
            <select value={state?.pnetwork ?? "all"} onChange={(event) => navigate({ pnetwork: event.target.value, ppage: 1 })} className="min-h-11 w-full rounded-xs border border-line-strong bg-surface px-3.5 text-base text-text sm:text-sm">
              <option value="all">Все соцсети</option>
              {(data?.options.networks ?? []).map((network) => <option key={network} value={network}>{NETWORK_LABEL[network] || network}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="type-caption mb-1.5 block text-text-3">Проект</span>
            <select value={state?.pproject ?? ""} onChange={(event) => navigate({ pproject: event.target.value, ppage: 1 })} className="min-h-11 w-full rounded-xs border border-line-strong bg-surface px-3.5 text-base text-text sm:text-sm">
              <option value="">Все проекты</option>
              {(data?.options.projects ?? []).map((project) => <option key={project.id} value={project.id}>{project.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="type-caption mb-1.5 block text-text-3">Код ошибки</span>
            <select value={state?.perror ?? ""} onChange={(event) => navigate({ perror: event.target.value, ppage: 1 })} className="min-h-11 w-full rounded-xs border border-line-strong bg-surface px-3.5 font-mono text-base text-text sm:text-sm">
              <option value="">Любой</option>
              {(data?.options.errorCodes ?? []).map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
          </label>
          <Button type="submit" variant="primary" loading={listState === "loading"} className="lg:col-span-2 2xl:col-span-1">Найти</Button>
        </form>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <label className="type-caption flex items-center gap-2 text-text-3">
            Сортировка
            <select value={state?.psort ?? "recent"} onChange={(event) => navigate({ psort: event.target.value, ppage: 1 })} className="min-h-9 rounded-xs border border-line bg-surface px-2.5 text-text">
              {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          {hasActiveFilters ? (
            <Button variant="ghost" size="sm" onClick={() => navigate({ pq: "", pstatus: "all", pnetwork: "all", pproject: null, perror: null, psort: "recent", ppage: 1 })}>
              Сбросить фильтры
            </Button>
          ) : null}
        </div>
      </div>

      {state ? <p className="type-caption mt-3 text-text-2">Выборка: {STATUS_OPTIONS.find(o => o.value === state.pstatus)?.label}{state.pq ? ` · «${state.pq}»` : ""}{state.pnetwork !== "all" ? ` · ${NETWORK_LABEL[state.pnetwork] || state.pnetwork}` : ""}{state.pproject ? ` · проект ${data?.options.projects.find(p => String(p.id) === state.pproject)?.label || state.pproject}` : ""}{state.perror ? ` · ${state.perror}` : ""}</p> : null}
      {message && pending?.kind !== "reschedule" ? (
        <p role="status" className={cn("mt-4 rounded-sm p-4", message.tone === "success" ? "bg-success-soft text-success-text" : "bg-danger-soft text-danger-text")}>{message.text}</p>
      ) : null}

      {listState === "error" ? <ReadError title="Не удалось загрузить публикации" onRetry={() => setRetryKey(v => v + 1)} /> : null}
      {listState === "loading" && !data ? (
        <div className="mt-5 space-y-3" aria-busy="true">
          {Array.from({ length: 6 }, (_, index) => <div key={index} className="skeleton h-20 rounded-md" />)}
          <p role="status" className="sr-only">Загружаем публикации…</p>
        </div>
      ) : null}

      {data ? (
        <div className="mt-5 min-w-0 max-w-full overflow-hidden rounded-md border border-line bg-surface shadow-soft" aria-busy={listState === "loading" || undefined}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-4 sm:px-5">
            <div>
              <h3 className="text-text">Публикации</h3>
              <div className="mt-1"><SnapshotNote checkedAt={data.checkedAt} period={`${numberLabel(data.pagination.total, "публикация", "публикации", "публикаций")} в выборке · все даты`} onRefresh={() => setRetryKey(v => v + 1)} /></div>
            </div>
            <span role="status" aria-live="polite" className="type-caption text-text-3">{listState === "loading" ? "Обновляем…" : ""}</span>
          </div>
          {data.items.length === 0 ? (
            <div className="p-8 text-center">
              <Search className="mx-auto h-8 w-8 text-text-3" aria-hidden />
              <h3 className="mt-3 text-text">{hasActiveFilters ? "По этим условиям публикаций нет" : "Публикаций пока нет"}</h3>
              <p className="type-secondary mt-2 text-text-2">{hasActiveFilters ? "Измените запрос или сбросьте фильтры. Отсутствие записей не подтверждает работу очереди." : "Здесь появятся посты, созданные пользователями."}</p>
            </div>
          ) : (
            <>
              <div className="hidden overflow-x-auto 2xl:block" role="region" aria-label="Список публикаций" tabIndex={0}>
                <table className="w-full text-start">
                  <thead className="bg-surface-2">
                    <tr>
                      <th className="px-4 py-3 text-start">Состояние</th>
                      <th className="px-4 py-3 text-start">Публикация</th>
                      <th className="px-4 py-3 text-start">Проект · канал · автор</th>
                      <th className="px-4 py-3 text-start">Время</th>
                      <th className="px-4 py-3 text-start">Действия</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.items.map((item) => {
                      const pill = statusTone(item);
                      return (
                        <tr key={item.id} className="align-top">
                          <td className="px-4 py-3">
                            <StatusPill {...pill} />
                            <p className="type-caption mt-2 max-w-xs text-text-2">{publicationHelp(item)}</p>
                            <p className="type-caption mt-1 text-text-3">Попыток: {item.attempts}</p>
                          </td>
                          <td className="max-w-md px-4 py-3">
                            <p className="type-secondary line-clamp-2 text-text" title={item.text}>{item.text}</p>
                            <PublicationDiagnostics item={item} />
                          </td>
                          <td className="px-4 py-3">
                            <p className="type-secondary font-semibold text-text">{item.project}</p>
                            <p className="type-caption mt-1 text-text-3">{NETWORK_LABEL[item.network] || item.network} · {item.channel}</p>
                            <a href={adminUsersHref(typeof window === "undefined" ? "/admin" : window.location.href, { user: item.authorId })} className="type-caption mt-1 inline-block text-brand hover:underline">{item.author}</a>
                          </td>
                          <td className="px-4 py-3 text-text-2">
                            <p className="type-secondary" title={item.scheduledAt ?? undefined}>{item.status === "published" ? fullDate(item.publishedAt) : fullDate(item.scheduledAt)}</p>
                            <p className="type-caption mt-1 text-text-3">{fmtAgo(item.publishedAt ?? item.scheduledAt ?? item.createdAt)}</p>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-2">
                              {item.canRetry ? (
                                <Button variant="primary" size="sm" loading={actionKey === `retry-${item.id}`} disabled={Boolean(actionKey) || stale || listState !== "ready"} onClick={() => { setMessage(null); setPending({ kind: "retry", item }); }}>
                                  <RefreshCw className="h-3.5 w-3.5" aria-hidden />Повторить попытку
                                </Button>
                              ) : null}
                              {item.canReschedule ? (
                                <Button variant="secondary" size="sm" disabled={Boolean(actionKey) || stale || listState !== "ready"} onClick={() => { setMessage(null); setRescheduleValue(defaultRescheduleValue()); setPending({ kind: "reschedule", item }); }}>
                                  <CalendarClock className="h-3.5 w-3.5" aria-hidden />Перенести
                                </Button>
                              ) : null}
                              {item.canCancel ? (
                                <Button variant="ghost" className="text-danger-text" size="sm" disabled={Boolean(actionKey) || stale || listState !== "ready"} onClick={() => { setMessage(null); setPending({ kind: "cancel", item }); }}>Отменить</Button>
                              ) : null}
                              {item.inFlight ? <span className="type-caption self-center text-text-3">Отправляется в сеть</span> : null}
                              {item.attention === "auth" && !item.inFlight ? (
                                <a href={adminUsersHref(typeof window === "undefined" ? "/admin" : window.location.href, { user: item.authorId })} className="type-caption self-center text-fire-text hover:underline">Сначала переподключить канал</a>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <ul className="divide-y divide-line 2xl:hidden">
                {data.items.map((item) => {
                  const pill = statusTone(item);
                  return (
                    <li key={item.id} className="p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <StatusPill {...pill} />
                        <span className="nums type-caption text-text-3">ID {item.id}</span>
                      </div>
                      <p className="type-secondary mt-3 line-clamp-3 text-text">{item.text}</p>
                      <p className="type-caption mt-2 text-text-2">{item.project} · {NETWORK_LABEL[item.network] || item.network} · {item.channel}</p>
                      <p className="type-caption mt-1 text-text-3"><a href={adminUsersHref(typeof window === "undefined" ? "/admin" : window.location.href, { user: item.authorId })} className="text-brand hover:underline">{item.author}</a> · {fullDate(item.status === "published" ? item.publishedAt : item.scheduledAt)}</p>
                      <p className="type-secondary mt-3 text-text-2">{publicationHelp(item)}</p><PublicationDiagnostics item={item} />
                      <div className="mt-3 flex flex-wrap gap-2">
                        {item.canRetry ? <Button variant="primary" size="sm" loading={actionKey === `retry-${item.id}`} disabled={Boolean(actionKey) || stale || listState !== "ready"} onClick={() => { setMessage(null); setPending({ kind: "retry", item }); }}>Повторить попытку</Button> : null}
                        {item.canReschedule ? <Button variant="secondary" size="sm" disabled={Boolean(actionKey) || stale || listState !== "ready"} onClick={() => { setMessage(null); setRescheduleValue(defaultRescheduleValue()); setPending({ kind: "reschedule", item }); }}>Перенести публикацию</Button> : null}
                        {item.canCancel ? <Button variant="ghost" className="text-danger-text" size="sm" disabled={Boolean(actionKey) || stale || listState !== "ready"} onClick={() => { setMessage(null); setPending({ kind: "cancel", item }); }}>Отменить</Button> : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {data.pagination.pages > 1 ? (
            <nav aria-label="Страницы публикаций" className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-4 sm:px-5">
              <p className="type-caption text-text-3">Страница {data.pagination.page} из {data.pagination.pages}</p>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" disabled={data.pagination.page <= 1 || listState === "loading"} onClick={() => navigate({ ppage: data.pagination.page - 1 })}><ChevronLeft className="h-4 w-4" aria-hidden />Предыдущая</Button>
                <Button variant="secondary" size="sm" disabled={data.pagination.page >= data.pagination.pages || listState === "loading"} onClick={() => navigate({ ppage: data.pagination.page + 1 })}>Следующая<ChevronRight className="h-4 w-4" aria-hidden /></Button>
              </div>
            </nav>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={pending?.kind === "retry"}
        error={message?.tone === "danger" ? message.text : undefined}
        title="Повторить отправку публикации?"
        description={pending ? `Публикация ${pending.item.id} «${pending.item.text.slice(0, 100)}» в канале «${pending.item.channel}» будет снова поставлена в очередь. Обработчик сможет отправить её сразу. Сначала устраните причину ошибки; результат появится в статусе публикации и журнале.` : ""}
        confirmLabel="Поставить в очередь" confirmVariant="primary" busy={Boolean(actionKey)}
        onCancel={() => setPending(null)}
        onConfirm={() => { if (pending) void performAction(pending.item, { action: "retry" }, `retry-${pending.item.id}`, `Публикация ${pending.item.id} снова в очереди. Отправка ещё не подтверждена.`).then(ok => { if (ok) setPending(null); }); }}
      />
      <ConfirmDialog
        open={pending?.kind === "cancel"}
        error={message?.tone === "danger" ? message.text : undefined}
        title="Отменить публикацию?"
        description={pending ? `Публикация ${pending.item.id} в «${pending.item.channel}» будет отменена; очередь её больше не отправит. Текст сохранится, автор увидит статус «Отменён». В этой панели отмену нельзя обратить; для отправки понадобится новая публикация.` : ""}
        confirmLabel="Отменить публикацию"
        busy={Boolean(pending && actionKey === `cancel-${pending.item.id}`)}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (!pending) return;
          const target = pending.item;
          void performAction(target, { action: "cancel", reason: "Отменено администратором" }, `cancel-${target.id}`, `Публикация ${target.id} отменена.`).then(ok => { if (ok) setPending(null); });
        }}
      />

      {pending?.kind === "reschedule" ? (
        <div ref={overlayRef} className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
          <form ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="admin-reschedule-title" aria-describedby="admin-reschedule-description" onKeyDown={onKeyDown} tabIndex={-1}
            className="card-plain max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto overscroll-contain rounded-lg p-6"
            onSubmit={(event) => {
              event.preventDefault();
              const target = pending.item;
              const scheduledAt = new Date(rescheduleValue);
              if (!Number.isFinite(scheduledAt.getTime())) return;
              void performAction(target, { action: "reschedule", scheduledAt: scheduledAt.toISOString() }, `reschedule-${target.id}`, `Публикация ${target.id} перенесена на ${fullDate(scheduledAt.toISOString())}.`).then(ok => { if (ok) setPending(null); });
            }}
          >
            <h3 id="admin-reschedule-title" className="text-text">Перенести публикацию {pending.item.id}</h3>
            <p id="admin-reschedule-description" className="type-secondary mt-2 text-text-2">Канал «{pending.item.channel}». Время: {Intl.DateTimeFormat().resolvedOptions().timeZone}. Публикация вернётся в очередь; карантин будет снят. Сначала устраните причину ошибки.</p>
            <label className="mt-4 block">
              <span className="type-caption mb-1.5 block text-text-3">Когда опубликовать</span>
              <input type="datetime-local" required value={rescheduleValue} onInput={(event) => setRescheduleValue(event.currentTarget.value)} onChange={(event) => setRescheduleValue(event.target.value)} className="min-h-11 w-full rounded-xs border border-line-strong bg-surface px-3.5 text-text" />
            </label>
            <p className="type-caption mt-3 text-text-3">Дата сохранится после нажатия «Перенести публикацию».</p>
            {message?.tone === "danger" ? <p role="alert" className="mt-3 rounded-sm bg-danger-soft p-3 text-danger-text">{message.text} Введённая дата сохранена в форме.</p> : null}
            <div className="mt-5 flex flex-wrap justify-end gap-3">
              <Button ref={cancelRef} disabled={Boolean(actionKey)} type="button" variant="ghost" onClick={() => setPending(null)}>Не переносить</Button>
              <Button type="submit" variant="primary" loading={actionKey === `reschedule-${pending.item.id}`}>Перенести публикацию</Button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}

export function publicationHelp(item: AdminPublicationItem) {
  if (item.attention === "auth" || ["needs_reconnect", "permission_lost", "revoked"].includes(item.channelStatus)) return "Доступ к каналу потерян. Откройте владельца и проверьте подключение до повторной отправки.";
  if (item.errorCode?.includes("too_long")) return "Текст превышает ограничение соцсети. Автору нужно сократить публикацию перед повтором.";
  if (item.attention === "overdue") return "Время публикации прошло более пяти минут назад. Проверьте очередь и обработчик в разделе «Система».";
  if (item.attention === "quarantined") return "Автоматическая отправка приостановлена после ошибок. Проверьте диагностику; повтор снимет блокировку.";
  if (item.errorCode?.includes("timeout")) return "Соцсеть не ответила вовремя. Проверьте, появился ли пост в канале, прежде чем повторять отправку.";
  if (item.attention === "failed") return "Отправка завершилась ошибкой. Текст сохранён. Проверьте диагностический код и подключение канала.";
  if (item.inFlight) return "Соцсеть обрабатывает отправку. Дождитесь результата; изменение публикации сейчас недоступно.";
  if (item.status === "published_unverified") return "Отправка принята, но наличие поста в соцсети ещё не подтверждено.";
  return "";
}
function PublicationDiagnostics({ item }: { item: AdminPublicationItem }) {
  return <details className="mt-2"><summary className="type-caption">Текст и диагностика · ID {item.id}</summary><div className="mt-2 space-y-2 rounded-sm bg-surface-inset p-3">
    <p className="type-secondary whitespace-pre-wrap text-text">{item.text || "Без текста"}</p>
    <CopyValue value={item.id} label="ID публикации" />
    {item.errorCode ? <div><CopyValue value={item.errorCode} label="код ошибки публикации" /></div> : null}
    {item.operationId ? <div><CopyValue value={item.operationId} label="ID операции" /></div> : null}
    <p className="type-caption text-text-3">Источник: {ORIGIN_LABEL[item.origin] ?? item.origin} · Попыток: {item.attempts} · Создано: {fullDate(item.createdAt)}</p>
    <a href="/admin#audit" className="type-caption inline-flex min-h-10 items-center text-info-text underline">Открыть журнал действий</a>
    <a href="/admin#system" className="type-caption ml-3 inline-flex min-h-10 items-center text-info-text underline">Проверить систему</a>
  </div></details>;
}
