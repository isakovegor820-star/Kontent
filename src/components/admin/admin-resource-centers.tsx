"use client";

import { useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Radio, Search } from "lucide-react";
import { Button, buttonClassName } from "@/components/ui/button";
import { adminJson, CopyValue, ReadError, SnapshotNote } from "./admin-ui";
import type { AdminAiSpendData, AdminConnectionsData } from "@/lib/admin-operations-data";
import { adminProjectsHref, adminUsersHref } from "@/lib/admin-url-state";
import { fmtNum, NETWORK_LABEL } from "@/lib/utils";

function useResource<T>(section: string, endpoint: string, days: number, refreshKey: number) {
  const [query, setQuery] = useState<URLSearchParams | null>(null);
  const [input, setInput] = useState("");
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ key: string; data: T | null; error: boolean } | null>(null);
  useEffect(() => {
    const sync = () => {
      const params = new URLSearchParams(window.location.search);
      const next = new URLSearchParams({ q: params.get(`${section}q`) || "", status: params.get(`${section}status`) || "all", page: params.get(`${section}page`) || "1" });
      setQuery(next); setInput(next.get("q") || "");
    };
    sync(); window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [section]);
  const key = query ? `${endpoint}?${query}&days=${days}&refresh=${refreshKey}-${retry}` : "";
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    void fetch(key, { cache: "no-store", signal: controller.signal }).then(adminJson<T>)
      .then(data => { if (!controller.signal.aborted) setResult({ key, data, error: false }); })
      .catch(() => { if (!controller.signal.aborted) setResult({ key, data: null, error: true }); });
    return () => controller.abort();
  }, [key]);
  function navigate(changes: Record<string, string>) {
    const params = new URLSearchParams(query || undefined);
    for (const [k, v] of Object.entries(changes)) params.set(k, v);
    const url = new URL(window.location.href);
    params.forEach((v, k) => { if (v && v !== "all" && !(k === "page" && v === "1")) url.searchParams.set(`${section}${k}`, v); else url.searchParams.delete(`${section}${k}`); });
    window.history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
    setQuery(params); setInput(params.get("q") || "");
  }
  const busy = !key || result?.key !== key;
  return { input, setInput, navigate, query, busy, data: !busy ? result?.data : null, error: !busy && result?.error, refresh: () => setRetry(v => v + 1) };
}

function ResourceFilters({ resource, label, placeholder, options }: {
  resource: Pick<ReturnType<typeof useResource>, "input" | "setInput" | "navigate" | "query" | "busy">;
  label: string; placeholder: string; options: { value: string; label: string }[];
}) {
  const active = resource.query?.get("q") || resource.query?.get("status") !== "all";
  const submit = (event: FormEvent) => { event.preventDefault(); resource.navigate({ q: resource.input.trim(), page: "1" }); };
  return <div className="card-plain rounded-md p-4 sm:p-5">
    <form onSubmit={submit} className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,.5fr)_auto]">
      <label className="type-caption block text-text-2">{label}<input type="search" value={resource.input} onChange={e => resource.setInput(e.target.value)} placeholder={placeholder} className="mt-2 min-h-11 w-full rounded-xs border border-line-strong bg-surface px-3 text-text" /></label>
      <label className="type-caption block text-text-2">Состояние<select value={resource.query?.get("status") || "all"} onChange={e => resource.navigate({ status: e.target.value, page: "1" })} className="mt-2 min-h-11 w-full rounded-xs border border-line-strong bg-surface px-3 text-text">{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
      <Button type="submit" loading={resource.busy}><Search className="h-4 w-4" aria-hidden />Найти</Button>
    </form>
    {active && resource.query ? <div className="type-caption mt-3 flex flex-wrap items-center gap-3 text-text-2"><span>Выборка: {resource.query.get("q") ? `«${resource.query.get("q")}» · ` : ""}{options.find(o => o.value === resource.query?.get("status"))?.label}</span><Button variant="ghost" size="sm" onClick={() => resource.navigate({ q: "", status: "all", page: "1" })}>Сбросить фильтры</Button></div> : null}
  </div>;
}
function ResourcePagination({ pagination, navigate }: { pagination: { page: number; pages: number; total: number }; navigate: (changes: Record<string, string>) => void }) {
  return <nav aria-label="Страницы результатов" className="type-caption mt-4 flex flex-wrap items-center justify-between gap-3 text-text-3">
    <span role="status">Найдено: {fmtNum(pagination.total)} · Страница {pagination.page} из {pagination.pages}</span>
    {pagination.pages > 1 ? <div className="flex gap-2"><Button variant="secondary" size="sm" disabled={pagination.page === 1} onClick={() => navigate({ page: String(pagination.page - 1) })}><ChevronLeft className="h-4 w-4" aria-hidden />Назад</Button><Button variant="secondary" size="sm" disabled={pagination.page === pagination.pages} onClick={() => navigate({ page: String(pagination.page + 1) })}>Далее<ChevronRight className="h-4 w-4" aria-hidden /></Button></div> : null}
  </nav>;
}
function LoadingResource() { return <div role="status" className="card-plain mt-4 rounded-md p-8 text-text-2">Загружаем данные…</div>; }
function EmptyResource({ filtered, title }: { filtered: boolean; title: string }) { return <div className="rounded-md border border-line bg-surface p-8 text-center"><Search className="mx-auto h-6 w-6 text-text-3" aria-hidden /><h2 className="mt-3 text-text">{filtered ? "По этим условиям ничего не найдено" : title}</h2><p className="type-secondary mt-2 text-text-2">{filtered ? "Измените запрос или сбросьте фильтры выше." : "Здесь появятся записи, когда платформа начнёт получать данные."}</p></div>; }

const CONNECTION_LABEL: Record<string, string> = { active: "Подключён", needs_reconnect: "Нужно переподключение", permission_lost: "Недостаточно прав", revoked: "Доступ отозван", disconnected: "Отключён" };
export function AdminConnectionsCenter({ refreshKey }: { refreshKey: number }) {
  const r = useResource<AdminConnectionsData>("cn", "/api/admin/connections", 7, refreshKey);
  const data = r.data;
  return <div className="space-y-5">
    <ResourceFilters resource={r} label="Поиск подключения" placeholder="Канал, @адрес, ID, проект, имя или email" options={[{ value: "all", label: "Все подключения" }, { value: "attention", label: "Требуют внимания" }, { value: "active", label: "Подключены" }, { value: "disconnected", label: "Отключены" }]} />
    <p className="type-caption text-text-3">Сначала проблемные, затем недавно изменённые. Статус подключения сохранён в базе; он не заменяет проверку доступности соцсети.</p>
    {r.busy ? <LoadingResource /> : null}
    {r.error ? <ReadError title="Не удалось загрузить подключения" onRetry={r.refresh} /> : null}
    {data ? <><SnapshotNote checkedAt={data.checkedAt} period="Текущее состояние подключений" onRefresh={r.refresh} />
      {data.items.length === 0 ? <EmptyResource filtered={Boolean(r.query?.get("q") || r.query?.get("status") !== "all")} title="Подключений пока нет" /> : <ul className="overflow-hidden rounded-md border border-line bg-surface divide-y divide-line">
        {data.items.map(c => <li key={c.id} className="grid gap-4 p-4 sm:p-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <div className="min-w-0"><p className="type-body-strong text-text">{c.title}</p><p className="type-caption mt-1 text-text-3">{NETWORK_LABEL[c.network] || c.network} · {c.handle || "Без публичного адреса"}</p><p className="type-caption mt-1 text-text-2">{c.project} · {c.user}</p><details className="mt-1"><summary className="type-caption">Диагностика подключения</summary><div className="mt-2 space-y-2"><CopyValue value={c.id} label="ID канала" />{c.errorCode ? <div><CopyValue value={c.errorCode} label="код ошибки подключения" /></div> : <p className="type-caption text-text-3">Код ошибки не зарегистрирован.</p>}<p className="type-caption text-text-3">Изменено {new Date(c.updatedAt).toLocaleString("ru-RU")}</p>{c.errorAt ? <p className="type-caption text-text-3">Ошибка {new Date(c.errorAt).toLocaleString("ru-RU")}</p> : null}</div></details></div>
          <div><span className={`type-caption inline-flex items-center gap-2 rounded-full px-3 py-1 ${c.active && c.status !== "active" ? "bg-fire-soft text-fire-text" : "bg-surface-inset text-text-2"}`}><Radio className="h-4 w-4 shrink-0" aria-hidden />{c.active ? CONNECTION_LABEL[c.status] || "Статус неизвестен" : "Отключён"}</span><p className="type-secondary mt-3 text-text-2">{c.active && c.status !== "active" ? "Владелец должен проверить права доступа и заново подключить канал в настройках проекта. Повтор публикации не восстановит доступ." : c.active ? "Проверьте публикации в карточке владельца, если сообщения не выходят." : "Канал отключён. Для возобновления отправки владелец должен подключить его снова."}</p></div>
          <a href={adminUsersHref(typeof window === "undefined" ? "/admin" : window.location.href, { user: c.userId })} className={buttonClassName({ variant: "secondary", size: "sm", className: "self-start" })}>Открыть владельца</a>
        </li>)}
      </ul>}
      <ResourcePagination pagination={data.pagination} navigate={r.navigate} /></> : null}
  </div>;
}

export function usd(microusd: string) {
  const amount = BigInt(microusd);
  const fraction = (amount % BigInt(1_000_000)).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${new Intl.NumberFormat("ru-RU").format(amount / BigInt(1_000_000))},${fraction} $`;
}
export function AdminAiSpendCenter({ period, refreshKey }: { period: number; refreshKey: number }) {
  const r = useResource<AdminAiSpendData>("ai", "/api/admin/ai-spend", period, refreshKey);
  const data = r.data?.availability === "not_configured" ? null : r.data;
  return <div className="space-y-5">
    <ResourceFilters resource={r} label="Поиск расходов" placeholder="Провайдер, модель, название или ID проекта" options={[{ value: "all", label: "Все попытки" }, { value: "unknown", label: "Расход не уточнён" }, { value: "failed", label: "Завершились ошибкой" }]} />
    {r.busy ? <LoadingResource /> : null}
    {r.error ? <ReadError title="Не удалось загрузить учёт расходов AI" onRetry={r.refresh} /> : null}
    {r.data?.availability === "not_configured" ? <section className="card-plain rounded-md p-5" aria-labelledby="ai-accounting-unavailable">
      <h2 id="ai-accounting-unavailable" className="text-text">Учёт расходов не подключён</h2>
      <p className="type-secondary mt-3 max-w-2xl text-text-2">Денежный журнал AI недоступен в текущей версии платформы. Стоимость и резервы неизвестны. Это не означает, что расходов нет.</p>
      <p className="type-secondary mt-2 max-w-2xl text-text-2">Количество генераций можно проверить в обзоре. Для денежных сумм потребуется подключение журнала расходов; до этого сверяйте стоимость в кабинете провайдера.</p>
      <a href="/admin#overview" className={buttonClassName({ variant: "secondary", className: "mt-4" })}>Открыть использование AI в обзоре</a>
      <SnapshotNote checkedAt={r.data.checkedAt} period="Доступность денежного журнала" onRefresh={r.refresh} />
    </section> : null}
    {data ? <><SnapshotNote checkedAt={data.checkedAt} period={`Последние ${data.periodDays} календарных дней, включая сегодня · UTC · USD`} onRefresh={r.refresh} />
      <div className="grid gap-3 sm:grid-cols-3">{[
        { label: "Расход по известному использованию", value: data.summary.attempts ? usd(data.summary.knownMicrousd) : "Нет данных", hint: "По токенам и тарифам, сохранённым в журнале" },
        { label: "Неуточнённый расход и резерв", value: data.summary.attempts ? usd(data.summary.reservedMicrousd) : "Нет данных", hint: `Без подтверждённого использования: ${fmtNum(data.summary.unknown)}` },
        { label: "Попытки обращения к AI", value: fmtNum(data.summary.attempts), hint: `С ошибкой: ${fmtNum(data.summary.failed)} · по текущим фильтрам` },
      ].map(m => <article key={m.label} className="card-plain rounded-md p-5"><p className="type-caption text-text-2">{m.label}</p><p className="nums mt-3 text-2xl font-semibold text-text">{m.value}</p><p className="type-caption mt-2 text-text-3">{m.hint}</p></article>)}</div>
      <p className="type-secondary rounded-sm bg-info-soft p-4 text-info-text">Это внутренний учёт по тарифам, а не счёт провайдера. Ошибка запроса может иметь стоимость. Резерв учитывается до уточнения использования; количество генераций и число оплачиваемых попыток могут различаться.</p>
      {data.summary.unknown > 0 ? <p className="type-secondary flex gap-2 text-fire-text"><AlertTriangle className="h-5 w-5 shrink-0" aria-hidden />Есть попытки без окончательной стоимости. Фильтр «Расход не уточнён» покажет затронутые проекты.</p> : null}
      {data.items.length === 0 ? <EmptyResource filtered={Boolean(r.query?.get("q") || r.query?.get("status") !== "all")} title="Записей о расходах пока нет" /> : <div className="overflow-x-auto rounded-md border border-line bg-surface" role="region" aria-label="Расходы по проектам и моделям" tabIndex={0}><table className="w-full min-w-[640px] text-left"><caption className="p-4 text-left type-caption text-text-3">По проектам и моделям · сначала наибольший расход с резервом</caption><thead className="bg-surface-2"><tr>{["Проект / модель", "Попытки", "Расход по использованию", "Неуточнённый / резерв"].map(t => <th key={t} scope="col" className="p-4">{t}</th>)}</tr></thead><tbody className="divide-y divide-line">{data.items.map(row => <tr key={`${row.projectId}:${row.provider}:${row.model}`}><td className="p-4"><a className="font-semibold text-info-text underline-offset-4 hover:underline" href={adminProjectsHref(typeof window === "undefined" ? "/admin" : window.location.href, { prid: row.projectId })}>{row.project}</a><p className="type-caption mt-1 text-text-3">{row.provider} · {row.model}</p></td><td className="nums p-4">{fmtNum(row.attempts)}<p className="type-caption text-text-3">С ошибкой: {row.failed}</p></td><td className="nums p-4">{usd(row.knownMicrousd)}</td><td className="nums p-4">{usd(row.reservedMicrousd)}<p className="type-caption text-text-3">Без уточнения: {row.unknown}</p></td></tr>)}</tbody></table></div>}
      <ResourcePagination pagination={data.pagination} navigate={r.navigate} />
    </> : null}
  </div>;
}
