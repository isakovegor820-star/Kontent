"use client";

import { ChevronLeft, ChevronRight, History, Search, ShieldAlert } from "lucide-react";
import { FormEvent, useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import type { AdminAuditItem, AdminAuditResponse } from "@/lib/admin-audit";
import { adminAuditActionLabel, adminAuditEntityLabel } from "@/lib/admin-labels";
import {
  adminAuditHref,
  adminAuditQuery,
  adminProjectsHref,
  adminPublicationsHref,
  adminUsersHref,
  type AdminAuditUrlChange,
  type AdminAuditUrlKey,
} from "@/lib/admin-url-state";
import { cn, fmtAgo, fmtNum, plural } from "@/lib/utils";

const AREA_LABEL: Record<string, string> = {
  publication: "Публикации",
  draft: "Черновики",
  project: "Проекты и команда",
  monthly_campaign: "Месячные кампании",
  growth: "Развитие",
  tracking: "Отслеживание",
  brand_dictionary: "Словарь бренда",
  typography: "Типографика",
  audience: "Ответы клиентам",
  tenchat: "TenChat",
  bot: "Бот",
};

/** Where an audit row leads: the entity's own admin screen when one exists. */
export function auditEntityHref(item: Pick<AdminAuditItem, "entityType" | "entityId" | "projectId" | "actorId">): string | null {
  const id = item.entityId && /^\d+$/u.test(item.entityId) ? Number(item.entityId) : null;
  switch (item.entityType) {
    case "post":
      return id ? adminPublicationsHref("/admin", { pq: id, pstatus: "all" }) : null;
    case "project":
      return adminProjectsHref("/admin", { prid: item.projectId });
    case "project_member":
    case "user":
      return id ? adminUsersHref("/admin", { user: id }) : null;
    default:
      return adminProjectsHref("/admin", { prid: item.projectId });
  }
}

export function AdminAuditCenter({ refreshKey = 0 }: { refreshKey?: number }) {
  const [state, setState] = useState<Record<AdminAuditUrlKey, string> | null>(null);
  const [input, setInput] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const [data, setData] = useState<AdminAuditResponse | null>(null);
  const [settled, setSettled] = useState<{ key: string; ok: boolean } | null>(null);
  const searchId = useId();

  const apiQuery = state ? new URLSearchParams({ q: state.aq, project: state.aproject, actor: state.aactor, area: state.aarea, page: state.apage }).toString() : null;
  const listKey = `${apiQuery}:${refreshKey}:${retryKey}`;
  const loading = !apiQuery || settled?.key !== listKey;
  const failed = settled?.key === listKey && !settled.ok;

  useEffect(() => {
    const sync = () => {
      const next = adminAuditQuery(window.location.search);
      setState(next);
      setInput(next.aq);
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  useEffect(() => {
    if (!apiQuery) return;
    const controller = new AbortController();
    void fetch(`/api/admin/audit?${apiQuery}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("unavailable");
        return response.json() as Promise<AdminAuditResponse>;
      })
      .then((payload) => {
        setData(payload);
        setSettled({ key: listKey, ok: true });
      })
      .catch(() => {
        if (!controller.signal.aborted) setSettled({ key: listKey, ok: false });
      });
    return () => controller.abort();
  }, [apiQuery, listKey]);

  function navigate(changes: AdminAuditUrlChange) {
    window.history.pushState({}, "", adminAuditHref(window.location.href, changes));
    const next = adminAuditQuery(window.location.search);
    setState(next);
    setInput(next.aq);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate({ aq: input.trim(), apage: 1 });
  }

  const hasFilters = state && (state.aq || state.aproject || state.aactor || state.aarea);

  return (
    <div className="min-w-0 max-w-full">
      <div className="rounded-md border border-line bg-surface p-4 shadow-soft sm:p-5">
        <form onSubmit={submit} className="grid gap-3 lg:grid-cols-2 lg:items-end 2xl:grid-cols-[minmax(16rem,1fr)_14rem_14rem_14rem_auto]">
          <label htmlFor={searchId} className="block">
            <span className="type-caption mb-1.5 block text-text-3">Поиск по журналу</span>
            <span className="relative block">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-text-3" aria-hidden />
              <input id={searchId} type="search" value={input} onChange={(event) => setInput(event.target.value)} placeholder="Действие, ID сущности, проект или исполнитель" className="min-h-11 w-full rounded-xs border border-line-strong bg-surface px-3.5 pl-10 text-base text-text outline-none placeholder:text-text-3 focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/20 sm:text-sm" />
            </span>
          </label>
          <label className="block">
            <span className="type-caption mb-1.5 block text-text-3">Область</span>
            <select value={state?.aarea ?? ""} onChange={(event) => navigate({ aarea: event.target.value, apage: 1 })} className="min-h-11 w-full rounded-xs border border-line-strong bg-surface px-3.5 text-base text-text sm:text-sm">
              <option value="">Все области</option>
              {(data?.options.areas ?? []).map((area) => <option key={area} value={area}>{AREA_LABEL[area] ?? area}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="type-caption mb-1.5 block text-text-3">Проект</span>
            <select value={state?.aproject ?? ""} onChange={(event) => navigate({ aproject: event.target.value, apage: 1 })} className="min-h-11 w-full rounded-xs border border-line-strong bg-surface px-3.5 text-base text-text sm:text-sm">
              <option value="">Все проекты</option>
              {(data?.options.projects ?? []).map((project) => <option key={project.id} value={project.id}>{project.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="type-caption mb-1.5 block text-text-3">Исполнитель</span>
            <select value={state?.aactor ?? ""} onChange={(event) => navigate({ aactor: event.target.value, apage: 1 })} className="min-h-11 w-full rounded-xs border border-line-strong bg-surface px-3.5 text-base text-text sm:text-sm">
              <option value="">Все</option>
              {(data?.options.actors ?? []).map((actor) => <option key={actor.id} value={actor.id}>{actor.label}</option>)}
            </select>
          </label>
          <Button type="submit" variant="primary" loading={loading} className="lg:col-span-2 2xl:col-span-1">Найти</Button>
        </form>
        {hasFilters ? <div className="mt-3 flex justify-end"><Button variant="ghost" size="sm" onClick={() => navigate({ aq: "", aproject: null, aactor: null, aarea: null, apage: 1 })}>Сбросить фильтры</Button></div> : null}
      </div>

      {failed && !data ? (
        <div className="mt-5 rounded-md bg-danger-soft p-6 text-center text-danger-text">
          <ShieldAlert className="mx-auto h-7 w-7" aria-hidden />
          <h3 className="mt-3">Не удалось загрузить журнал</h3>
          <Button variant="danger" className="mt-4" onClick={() => setRetryKey((value) => value + 1)}>Повторить</Button>
        </div>
      ) : null}
      {loading && !data ? <div className="mt-5 space-y-2" aria-busy="true">{Array.from({ length: 8 }, (_, index) => <div key={index} className="skeleton h-12 rounded-sm" />)}</div> : null}

      {data ? (
        <div className="mt-5 overflow-hidden rounded-md border border-line bg-surface shadow-soft" aria-busy={loading || undefined}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
            <p className="type-caption text-text-3">{fmtNum(data.pagination.total)} {plural(data.pagination.total, "запись", "записи", "записей")} · страница {data.pagination.page} из {data.pagination.pages}</p>
            <span role="status" aria-live="polite" className="type-caption text-text-3">{loading ? "Обновляем…" : ""}</span>
          </div>
          {data.items.length === 0 ? <p className="p-6 text-text-2">Записей не найдено.</p> : (
            <ol className="divide-y divide-line">
              {data.items.map((event) => {
                const href = auditEntityHref(event);
                const extras = Object.entries(event.safeData).filter(([key]) => !["by"].includes(key));
                return (
                  <li key={event.id} className="flex gap-3 px-4 py-3 sm:items-start sm:px-5">
                    <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-surface-inset text-text-2"><History className="h-4 w-4" aria-hidden /></span>
                    <div className="min-w-0 flex-1">
                      <p className="type-secondary font-semibold text-text" title={event.action}>{adminAuditActionLabel(event.action)}</p>
                      <p className="type-caption mt-0.5 flex flex-wrap gap-x-2 text-text-3">
                        <a href={adminProjectsHref("/admin", { prid: event.projectId })} className="text-brand hover:underline">{event.project}</a>
                        <span>·</span>
                        {event.actorId ? <a href={adminUsersHref("/admin", { user: event.actorId })} className="text-brand hover:underline">{event.actor}</a> : <span>{event.actor}</span>}
                        <span>·</span>
                        {href ? <a href={href} className="text-brand hover:underline">{adminAuditEntityLabel(event.entityType)}{event.entityId ? ` ${event.entityId}` : ""}</a> : <span>{adminAuditEntityLabel(event.entityType)}{event.entityId ? ` ${event.entityId}` : ""}</span>}
                        {extras.length > 0 ? <span className={cn("font-mono text-text-3")}>· {extras.map(([key, value]) => `${key}=${String(value)}`).join(" ")}</span> : null}
                      </p>
                    </div>
                    <time className="type-caption shrink-0 text-text-3" dateTime={event.createdAt} title={new Date(event.createdAt).toLocaleString("ru-RU")}>{fmtAgo(event.createdAt)}</time>
                  </li>
                );
              })}
            </ol>
          )}
          {data.pagination.pages > 1 ? (
            <nav aria-label="Страницы журнала" className="flex items-center justify-end gap-2 border-t border-line px-4 py-3 sm:px-5">
              <Button variant="secondary" size="sm" disabled={data.pagination.page <= 1 || loading} onClick={() => navigate({ apage: data.pagination.page - 1 })}><ChevronLeft className="h-4 w-4" aria-hidden />Предыдущая</Button>
              <Button variant="secondary" size="sm" disabled={data.pagination.page >= data.pagination.pages || loading} onClick={() => navigate({ apage: data.pagination.page + 1 })}>Следующая<ChevronRight className="h-4 w-4" aria-hidden /></Button>
            </nav>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
