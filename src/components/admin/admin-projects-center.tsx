"use client";

import {
  Activity,
  Bot,
  BriefcaseBusiness,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileText,
  History,
  Radio,
  Search,
  Send,
  ShieldAlert,
  Sparkles,
  Users,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { FormEvent, useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import type { AdminPeriodDays } from "@/lib/admin-dashboard";
import { adminAuditActionLabel, adminAuditEntityLabel } from "@/lib/admin-labels";
import type {
  AdminProjectDetail,
  AdminProjectListItem,
  AdminProjectsResponse,
  AdminProjectSort,
  AdminProjectStatusFilter,
} from "@/lib/admin-projects";
import {
  adminProjectsHref,
  adminProjectsQuery,
  adminPublicationsHref,
  adminUsersHref,
  type AdminProjectsUrlChange,
  type AdminProjectsUrlKey,
} from "@/lib/admin-url-state";
import { cn, fmtAgo, fmtNum, NETWORK_LABEL, plural } from "@/lib/utils";

type ListState = "loading" | "ready" | "error";
type DetailState = "idle" | "loading" | "ready" | "error" | "not_found";

const STATUS_OPTIONS: Array<{ value: AdminProjectStatusFilter; label: string }> = [
  { value: "all", label: "Все проекты" },
  { value: "attention", label: "Требуют внимания" },
  { value: "active", label: "Активные" },
  { value: "inactive", label: "Без публикаций за период" },
  { value: "team", label: "Командные" },
  { value: "personal", label: "Личные" },
  { value: "archived", label: "Архивные" },
];

const SORT_OPTIONS: Array<{ value: AdminProjectSort; label: string }> = [
  { value: "activity_desc", label: "По последней активности" },
  { value: "created_desc", label: "Сначала новые" },
  { value: "posts_desc", label: "По публикациям за период" },
  { value: "members_desc", label: "По числу участников" },
];

const ROLE_LABEL: Record<string, string> = {
  owner: "Владелец",
  author: "Автор",
  approver: "Согласующий",
  publisher: "Публикатор",
};

const POST_STATUS_LABEL: Record<string, string> = {
  draft: "Черновик",
  scheduled: "Запланирован",
  publishing: "Публикуется",
  published_unverified: "Не подтверждён сетью",
  published: "Опубликован",
  missing: "Не найден в соцсети",
  deleted_external: "Удалён в соцсети",
  failed_retry: "Ждёт повтора",
  quarantined: "Карантин",
  failed: "Ошибка",
  cancelled: "Отменён",
};

const CHANNEL_STATUS_LABEL: Record<string, string> = {
  active: "Подключён",
  needs_reconnect: "Нужно переподключение",
  permission_lost: "Недостаточно прав",
  revoked: "Доступ отозван",
  disconnected: "Отключён",
};

function numberLabel(value: number, one: string, few: string, many: string) {
  return `${fmtNum(value)} ${plural(value, one, few, many)}`;
}

function fullDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString("ru-RU", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function Pill({ label, tone, icon: Icon }: { label: string; tone: "success" | "danger" | "warning" | "neutral" | "brand"; icon?: LucideIcon }) {
  return (
    <span className={cn(
      "type-caption inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 font-semibold whitespace-nowrap",
      tone === "success" && "bg-success-soft text-success-text",
      tone === "danger" && "bg-danger-soft text-danger-text",
      tone === "warning" && "bg-fire-soft text-fire-text",
      tone === "brand" && "bg-info-soft text-info-text",
      tone === "neutral" && "bg-surface-inset text-text-2",
    )}>
      {Icon ? <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
      {label}
    </span>
  );
}

function projectState(project: AdminProjectListItem) {
  if (project.archived) return { label: "Архив", tone: "neutral" as const, icon: Clock3 };
  if (project.channelAttention > 0 || project.failedPeriod > 0) return { label: "Требует внимания", tone: "danger" as const, icon: ShieldAlert };
  if (project.postsPeriod > 0) return { label: "Публикует", tone: "success" as const, icon: Activity };
  if (project.channels === 0) return { label: "Без каналов", tone: "warning" as const, icon: Radio };
  return { label: "Тихий период", tone: "neutral" as const, icon: Clock3 };
}

function SummaryCard({ label, value, helper, icon: Icon }: { label: string; value: number; helper: string; icon: LucideIcon }) {
  return (
    <article className="min-w-0 rounded-sm bg-surface-inset p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="type-caption text-text-3">{label}</p>
        <Icon className="h-4 w-4 shrink-0 text-brand" strokeWidth={1.8} aria-hidden />
      </div>
      <p className="nums mt-3 text-2xl font-bold leading-none tracking-tight text-text">{fmtNum(value)}</p>
      <p className="type-caption mt-2 text-pretty text-text-3">{helper}</p>
    </article>
  );
}

function ActivityBars({ data }: { data: AdminProjectDetail["activity"] }) {
  const maximum = Math.max(1, ...data.flatMap((item) => [item.posts, item.published, item.failed]));
  return (
    <section className="rounded-md border border-line bg-surface p-5" aria-labelledby="project-activity-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="project-activity-title" className="text-text">Динамика публикаций</h3>
          <p className="type-caption mt-1 text-text-3">Создано, опубликовано и упало по дням</p>
        </div>
        <div className="type-caption flex flex-wrap gap-3 text-text-2" aria-label="Легенда">
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-brand" />Создано</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-success" />Опубликовано</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-danger" />Ошибки</span>
        </div>
      </div>
      <div className="mt-5 overflow-x-auto pb-2">
        <ul className="flex h-40 min-w-max items-end gap-2" aria-label="Публикации проекта по дням">
          {data.map((item, index) => {
            const date = new Date(`${item.date}T12:00:00Z`).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
            const showDate = data.length <= 7 || index % 5 === 0 || index === data.length - 1;
            return (
              <li key={item.date} className={cn("flex shrink-0 flex-col items-center gap-1", data.length <= 7 ? "w-14" : "w-11")} title={`${date}: создано ${item.posts}, опубликовано ${item.published}, ошибки ${item.failed}`}>
                <div className="flex h-28 items-end gap-0.5" aria-hidden>
                  {[{ value: item.posts, color: "bg-brand" }, { value: item.published, color: "bg-success" }, { value: item.failed, color: "bg-danger" }].map((bar, barIndex) => (
                    <span key={barIndex} className={cn("w-3 rounded-t-sm", bar.color)} style={{ height: Math.max(bar.value > 0 ? 6 : 2, (bar.value / maximum) * 104) }} />
                  ))}
                </div>
                <span className="type-caption h-4 whitespace-nowrap text-text-3" aria-hidden>{showDate ? date : ""}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

function DetailContent({ detail }: { detail: AdminProjectDetail }) {
  const { project, summary } = detail;
  return (
    <div className="space-y-10 p-4 sm:p-6">
      <section aria-label="Сводка проекта">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryCard label="Участники" value={summary.members} helper="Активные членства" icon={Users} />
          <SummaryCard label="Каналы" value={summary.channels} helper={`${fmtNum(summary.activeChannels)} активных · ${fmtNum(summary.channelAttention)} с ошибкой`} icon={Radio} />
          <SummaryCard label="Публикации" value={summary.postsTotal} helper={`${fmtNum(summary.postsPeriod)} за ${detail.periodDays} дней`} icon={FileText} />
          <SummaryCard label="Опубликовано" value={summary.publishedPeriod} helper={`${fmtNum(summary.scheduled)} запланировано`} icon={Send} />
          <SummaryCard label="Ошибки за период" value={summary.failedPeriod} helper="Ошибка, повтор или карантин" icon={ShieldAlert} />
          <SummaryCard label="Черновики" value={summary.drafts} helper="Сохранённый контент" icon={FileText} />
          <SummaryCard label="AI за период" value={summary.aiPeriod} helper="Генерации участников проекта" icon={Sparkles} />
          <SummaryCard label="Автопилот" value={project.autopilotEnabled ? 1 : 0} helper={project.autopilotEnabled ? `Включён · режим ${project.autopilotMode ?? "—"}` : "Выключен"} icon={Bot} />
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-md border border-line bg-surface p-5">
          <h3 className="text-text">Проект</h3>
          <dl className="mt-5 grid gap-4 sm:grid-cols-2">
            <div><dt className="type-caption text-text-3">Создан</dt><dd className="type-secondary mt-1 text-text">{fullDate(project.createdAt)}</dd></div>
            <div><dt className="type-caption text-text-3">Часовой пояс</dt><dd className="type-secondary mt-1 text-text">{project.timezone}</dd></div>
            <div><dt className="type-caption text-text-3">Тип</dt><dd className="mt-1"><Pill label={project.personal ? "Личный" : "Командный"} tone={project.personal ? "neutral" : "brand"} icon={BriefcaseBusiness} /></dd></div>
            <div><dt className="type-caption text-text-3">Состояние</dt><dd className="mt-1"><Pill label={project.archived ? "Архивирован" : "Активен"} tone={project.archived ? "neutral" : "success"} icon={project.archived ? Clock3 : CheckCircle2} /></dd></div>
            <div><dt className="type-caption text-text-3">Telegram-бот</dt><dd className="mt-1"><Pill label={project.botEnabled ? "Доступен в боте" : "Приостановлен"} tone={project.botEnabled ? "success" : "danger"} icon={Bot} /></dd></div>
            <div><dt className="type-caption text-text-3">ID проекта</dt><dd className="nums type-secondary mt-1 text-text">{project.id} · версия {project.version}</dd></div>
          </dl>
          {project.botDisabledReason ? <p className="type-caption mt-4 rounded-sm bg-danger-soft p-3 text-danger-text">Причина: {project.botDisabledReason}</p> : null}
          <div className="mt-5 flex flex-wrap gap-2">
            <a href={adminPublicationsHref("/admin", { pproject: project.id, pstatus: "all" })} className="type-button min-h-9 rounded-sm border border-line px-3 text-brand hover:bg-surface-inset">Публикации проекта</a>
            <a href={adminPublicationsHref("/admin", { pproject: project.id, pstatus: "attention" })} className="type-button min-h-9 rounded-sm border border-line px-3 text-brand hover:bg-surface-inset">Проблемные публикации</a>
          </div>
        </div>
        <ActivityBars data={detail.activity} />
      </section>

      <section aria-labelledby="project-members-title">
        <div><p className="type-label text-brand">Команда</p><h3 id="project-members-title" className="mt-2 text-text">Участники</h3></div>
        {detail.members.length === 0 ? <p className="mt-4 rounded-sm bg-surface-inset p-4 text-text-2">Участников нет.</p> : (
          <div className="mt-5 overflow-hidden rounded-md border border-line bg-surface">
            <table className="w-full text-start">
              <thead className="bg-surface-2"><tr><th className="px-4 py-3 text-start">Участник</th><th className="px-4 py-3 text-start">Роль</th><th className="px-4 py-3 text-start">В проекте с</th><th className="px-4 py-3 text-start">Последний вход</th><th className="px-4 py-3 text-start">Постов за период</th></tr></thead>
              <tbody className="divide-y divide-line">
                {detail.members.map((member) => (
                  <tr key={member.userId} className={cn(member.status !== "active" && "opacity-60")}>
                    <td className="px-4 py-3"><a href={adminUsersHref("/admin", { user: member.userId })} className="type-secondary font-semibold text-brand hover:underline">{member.name}</a><p className="type-caption mt-0.5 text-text-3">{member.email ?? `ID ${member.userId}`}{member.botLinked ? " · чат привязан" : ""}</p></td>
                    <td className="px-4 py-3"><Pill label={member.status === "active" ? ROLE_LABEL[member.role] ?? member.role : "Доступ отозван"} tone={member.status === "active" ? "brand" : "neutral"} /></td>
                    <td className="px-4 py-3 text-text-2">{fullDate(member.joinedAt)}</td>
                    <td className="px-4 py-3 text-text-2">{member.lastSignedInAt ? fmtAgo(member.lastSignedInAt) : "—"}</td>
                    <td className="nums px-4 py-3 text-text-2">{member.postsPeriod}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="project-channels-title">
        <div><p className="type-label text-brand">Интеграции</p><h3 id="project-channels-title" className="mt-2 text-text">Каналы</h3></div>
        {detail.channels.length === 0 ? <p className="mt-4 rounded-sm bg-surface-inset p-4 text-text-2">Каналы ещё не подключены.</p> : (
          <ul className="mt-5 grid gap-4 xl:grid-cols-2">
            {detail.channels.map((channel) => {
              const healthy = channel.active && channel.status === "active";
              return (
                <li key={channel.id} className="rounded-md border border-line bg-surface p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0"><p className="type-body-strong break-words text-text">{channel.title}</p><p className="type-caption mt-1 text-text-3">{NETWORK_LABEL[channel.network] || channel.network}{channel.handle ? ` · ${channel.handle}` : ""} · ID {channel.id}</p></div>
                    <Pill label={CHANNEL_STATUS_LABEL[channel.status] ?? channel.status} tone={healthy ? "success" : channel.active ? "danger" : "neutral"} icon={healthy ? CheckCircle2 : channel.active ? ShieldAlert : XCircle} />
                  </div>
                  <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div><dt className="type-caption text-text-3">Посты</dt><dd className="nums type-body-strong mt-1 text-text">{channel.posts}</dd></div>
                    <div><dt className="type-caption text-text-3">Вышло</dt><dd className="nums type-body-strong mt-1 text-text">{channel.published}</dd></div>
                    <div><dt className="type-caption text-text-3">В плане</dt><dd className="nums type-body-strong mt-1 text-text">{channel.scheduled}</dd></div>
                    <div><dt className="type-caption text-text-3">Ошибки</dt><dd className="nums type-body-strong mt-1 text-text">{channel.failed}</dd></div>
                  </dl>
                  <p className="type-caption mt-3 text-text-3">Подписчики: <span className="nums font-semibold text-text">{channel.subscribers == null ? "нет данных" : fmtNum(channel.subscribers)}</span> · подключён {fullDate(channel.createdAt)}</p>
                  {channel.lastAuthErrorCode ? <p className="type-caption mt-3 rounded-sm bg-danger-soft p-3 font-mono text-danger-text">{channel.lastAuthErrorCode}{channel.lastAuthErrorAt ? ` · ${fmtAgo(channel.lastAuthErrorAt)}` : ""}</p> : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="project-posts-title">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div><p className="type-label text-brand">Контент</p><h3 id="project-posts-title" className="mt-2 text-text">Последние публикации</h3></div>
          <a href={adminPublicationsHref("/admin", { pproject: project.id, pstatus: "all" })} className="type-caption text-brand hover:underline">Все публикации проекта</a>
        </div>
        {detail.posts.length === 0 ? <p className="mt-4 rounded-sm bg-surface-inset p-4 text-text-2">Публикаций ещё нет.</p> : (
          <ul className="mt-5 divide-y divide-line overflow-hidden rounded-md border border-line bg-surface">
            {detail.posts.map((post) => (
              <li key={post.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="type-secondary line-clamp-2 text-text">{post.text}</p>
                  <p className="type-caption mt-1 text-text-3"><span className="nums">ID {post.id}</span> · {NETWORK_LABEL[post.network] || post.network} · {post.channel} · <a href={adminUsersHref("/admin", { user: post.authorId })} className="text-brand hover:underline">{post.author}</a></p>
                  {post.safeErrorCode ? <p className="type-caption mt-1 font-mono text-danger-text">{post.safeErrorCode}</p> : null}
                </div>
                <div className="shrink-0 text-end">
                  <Pill label={POST_STATUS_LABEL[post.status] ?? post.status} tone={post.status === "published" ? "success" : ["failed", "missing", "deleted_external"].includes(post.status) ? "danger" : ["failed_retry", "quarantined", "published_unverified"].includes(post.status) ? "warning" : post.status === "scheduled" ? "brand" : "neutral"} />
                  <p className="type-caption mt-1 text-text-3">{fullDate(post.publishedAt ?? post.scheduledAt ?? post.createdAt)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="project-audit-title">
        <div><p className="type-label text-brand">Контроль</p><h3 id="project-audit-title" className="mt-2 text-text">Журнал проекта</h3></div>
        {detail.audit.length === 0 ? <p className="mt-4 rounded-sm bg-surface-inset p-4 text-text-2">Записей нет.</p> : (
          <ol className="mt-5 space-y-3">
            {detail.audit.map((event) => (
              <li key={event.id} className="flex items-start gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-surface-inset text-text-2"><History className="h-4 w-4" aria-hidden /></span>
                <div className="min-w-0"><p className="type-secondary font-semibold text-text" title={event.action}>{adminAuditActionLabel(event.action)}</p><p className="type-caption mt-0.5 text-text-3">{event.actor} · {adminAuditEntityLabel(event.entityType)}{event.entityId ? ` ${event.entityId}` : ""} · {fmtAgo(event.createdAt)}</p></div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function stateFromSearch(search: string): Record<AdminProjectsUrlKey, string> {
  const raw = adminProjectsQuery(search);
  return {
    ...raw,
    prstatus: STATUS_OPTIONS.some((option) => option.value === raw.prstatus) ? raw.prstatus : "all",
    prsort: SORT_OPTIONS.some((option) => option.value === raw.prsort) ? raw.prsort : "activity_desc",
    prpage: Number.isSafeInteger(Number(raw.prpage)) && Number(raw.prpage) > 0 ? raw.prpage : "1",
    prid: /^\d+$/u.test(raw.prid) ? raw.prid : "",
  };
}

export function AdminProjectsCenter({ period, refreshKey = 0 }: { period: AdminPeriodDays; refreshKey?: number }) {
  const [state, setState] = useState<Record<AdminProjectsUrlKey, string> | null>(null);
  const [input, setInput] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const [data, setData] = useState<AdminProjectsResponse | null>(null);
  const [listSettled, setListSettled] = useState<{ key: string; ok: boolean } | null>(null);
  const [detailSettled, setDetailSettled] = useState<{ key: string; state: Exclude<DetailState, "idle" | "loading">; detail: AdminProjectDetail | null } | null>(null);
  const [selectedName, setSelectedName] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchId = useId();
  const dialogTitleId = useId();

  const listParams = state ? new URLSearchParams({ days: String(period), q: state.prq, status: state.prstatus, network: state.prnetwork, sort: state.prsort, page: state.prpage }).toString() : null;
  const listKey = `${listParams}:${refreshKey}:${retryKey}`;
  const listState: ListState = !listParams || listSettled?.key !== listKey ? "loading" : listSettled.ok ? "ready" : "error";
  const detailKey = state?.prid ? `${state.prid}:${period}:${refreshKey}` : null;
  const detailState: DetailState = !detailKey ? "idle" : detailSettled?.key !== detailKey ? "loading" : detailSettled.state;
  const detail = detailState === "ready" ? detailSettled?.detail ?? null : null;

  useEffect(() => {
    const sync = () => {
      const next = stateFromSearch(window.location.search);
      setState(next);
      setInput(next.prq);
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  useEffect(() => {
    if (!listParams) return;
    const controller = new AbortController();
    void fetch(`/api/admin/projects?${listParams}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("unavailable");
        return response.json() as Promise<AdminProjectsResponse>;
      })
      .then((payload) => {
        setData(payload);
        setListSettled({ key: listKey, ok: true });
      })
      .catch(() => {
        if (!controller.signal.aborted) setListSettled({ key: listKey, ok: false });
      });
    return () => controller.abort();
  }, [listParams, listKey]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!detailKey || !state?.prid) {
      if (dialog?.open) dialog.close();
      return;
    }
    if (dialog && !dialog.open) dialog.showModal();
    const controller = new AbortController();
    void fetch(`/api/admin/projects/${state.prid}?days=${period}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (response.status === 404) throw new Error("not_found");
        if (!response.ok) throw new Error("unavailable");
        return response.json() as Promise<AdminProjectDetail>;
      })
      .then((payload) => {
        setSelectedName(payload.project.name);
        setDetailSettled({ key: detailKey, state: "ready", detail: payload });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setDetailSettled({ key: detailKey, state: error instanceof Error && error.message === "not_found" ? "not_found" : "error", detail: null });
      });
    return () => controller.abort();
  }, [detailKey, state?.prid, period]);

  function navigate(changes: AdminProjectsUrlChange) {
    window.history.pushState({}, "", adminProjectsHref(window.location.href, changes));
    const next = stateFromSearch(window.location.search);
    setState(next);
    setInput(next.prq);
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate({ prq: input.trim(), prpage: 1 });
  }

  function closeDetail() {
    if (state?.prid) navigate({ prid: null });
    else dialogRef.current?.close();
  }

  const hasActiveFilters = state && (state.prq || state.prstatus !== "all" || state.prnetwork !== "all");

  return (
    <>
      {data ? (
        <div className="grid min-w-0 max-w-full gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          <SummaryCard label="Все проекты" value={data.summary.projects} helper={`${fmtNum(data.summary.archived)} в архиве`} icon={BriefcaseBusiness} />
          <SummaryCard label="Активные" value={data.summary.active} helper="Не архивированы" icon={Activity} />
          <SummaryCard label="Командные" value={data.summary.team} helper="Больше одного участника возможно" icon={Users} />
          <SummaryCard label="С каналами" value={data.summary.withChannels} helper="Хотя бы один активный канал" icon={Radio} />
          <SummaryCard label="Требуют внимания" value={data.summary.attention} helper="Ошибки каналов или публикаций" icon={ShieldAlert} />
          <SummaryCard label="Новые" value={data.summary.newPeriod} helper={`За ${data.periodDays} дней`} icon={Sparkles} />
        </div>
      ) : null}

      <div className="mt-5 rounded-md border border-line bg-surface p-4 shadow-soft sm:p-5">
        <form onSubmit={submitSearch} className="grid gap-4 lg:grid-cols-2 lg:items-end 2xl:grid-cols-[minmax(16rem,1fr)_14rem_12rem_15rem_auto]">
          <label htmlFor={searchId} className="block">
            <span className="type-caption mb-1.5 block text-text-3">Поиск проекта</span>
            <span className="relative block">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-text-3" aria-hidden />
              <input id={searchId} type="search" value={input} onChange={(event) => setInput(event.target.value)} placeholder="Название, ID или владелец" className="min-h-11 w-full rounded-xs border border-line-strong bg-surface px-3.5 pl-10 text-base text-text outline-none transition-[border-color,box-shadow] placeholder:text-text-3 focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/20 sm:text-sm" />
            </span>
          </label>
          <label className="block">
            <span className="type-caption mb-1.5 block text-text-3">Состояние</span>
            <select value={state?.prstatus ?? "all"} onChange={(event) => navigate({ prstatus: event.target.value, prpage: 1 })} className="min-h-11 w-full rounded-xs border border-line-strong bg-surface px-3.5 text-base text-text sm:text-sm">
              {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="type-caption mb-1.5 block text-text-3">Соцсеть</span>
            <select value={state?.prnetwork ?? "all"} onChange={(event) => navigate({ prnetwork: event.target.value, prpage: 1 })} className="min-h-11 w-full rounded-xs border border-line-strong bg-surface px-3.5 text-base text-text sm:text-sm">
              <option value="all">Все соцсети</option>
              {["tg", "vk", "instagram", "youtube", "x", "tiktok", "linkedin", "tenchat"].map((network) => <option key={network} value={network}>{NETWORK_LABEL[network] || network}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="type-caption mb-1.5 block text-text-3">Сортировка</span>
            <select value={state?.prsort ?? "activity_desc"} onChange={(event) => navigate({ prsort: event.target.value, prpage: 1 })} className="min-h-11 w-full rounded-xs border border-line-strong bg-surface px-3.5 text-base text-text sm:text-sm">
              {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <Button type="submit" variant="primary" loading={listState === "loading"} className="lg:col-span-2 2xl:col-span-1">Найти проект</Button>
        </form>
        {hasActiveFilters ? (
          <div className="mt-4 flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => navigate({ prq: "", prstatus: "all", prnetwork: "all", prpage: 1 })}>Сбросить фильтры</Button>
          </div>
        ) : null}
      </div>

      {listState === "error" && !data ? (
        <div className="mt-5 rounded-md bg-danger-soft p-6 text-center text-danger-text">
          <ShieldAlert className="mx-auto h-7 w-7" aria-hidden />
          <h3 className="mt-3">Не удалось загрузить проекты</h3>
          <Button variant="danger" className="mt-4" onClick={() => setRetryKey((value) => value + 1)}>Повторить загрузку</Button>
        </div>
      ) : null}
      {listState === "loading" && !data ? (
        <div className="mt-5 space-y-3" aria-busy="true">
          {Array.from({ length: 6 }, (_, index) => <div key={index} className="skeleton h-16 rounded-md" />)}
          <p role="status" className="sr-only">Загружаем проекты…</p>
        </div>
      ) : null}

      {data ? (
        <div className="mt-5 min-w-0 max-w-full overflow-hidden rounded-md border border-line bg-surface shadow-soft" aria-busy={listState === "loading" || undefined}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-4 sm:px-5">
            <div>
              <h3 className="text-text">Проекты</h3>
              <p className="type-caption mt-1 text-text-3">{numberLabel(data.pagination.total, "проект", "проекта", "проектов")} в выборке</p>
            </div>
            <span role="status" aria-live="polite" className="type-caption text-text-3">{listState === "loading" ? "Обновляем…" : ""}</span>
          </div>
          {data.projects.length === 0 ? (
            <div className="p-8 text-center">
              <Search className="mx-auto h-8 w-8 text-text-3" aria-hidden />
              <h3 className="mt-3 text-text">Проекты не найдены</h3>
              <p className="type-secondary mt-2 text-text-2">Измените запрос или сбросьте фильтры.</p>
            </div>
          ) : (
            <>
              <div className="hidden overflow-x-auto lg:block">
                <table className="w-full text-start">
                  <thead className="bg-surface-2">
                    <tr><th className="px-4 py-3 text-start">Проект</th><th className="px-4 py-3 text-start">Владелец</th><th className="px-4 py-3 text-start">Команда · каналы</th><th className="px-4 py-3 text-start">Публикации за период</th><th className="px-4 py-3 text-start">Активность</th><th className="px-4 py-3 text-start">Состояние</th><th className="px-4 py-3" aria-label="Действие" /></tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.projects.map((project) => {
                      const pill = projectState(project);
                      return (
                        <tr key={project.id} className="align-middle transition-colors duration-150 hover:bg-surface-2/60">
                          <td className="px-4 py-3">
                            <p className="type-body-strong max-w-64 truncate text-text" title={project.name}>{project.name}</p>
                            <p className="type-caption mt-0.5 text-text-3"><span className="nums">ID {project.id}</span> · {project.personal ? "личный" : "командный"} · {project.timezone}{project.autopilotEnabled ? " · автопилот" : ""}{!project.botEnabled ? " · бот приостановлен" : ""}</p>
                          </td>
                          <td className="px-4 py-3">{project.ownerId ? <a href={adminUsersHref("/admin", { user: project.ownerId })} className="type-secondary text-brand hover:underline">{project.owner}</a> : <span className="type-caption text-text-3">Нет владельца</span>}</td>
                          <td className="px-4 py-3">
                            <p className="nums type-secondary text-text">{numberLabel(project.members, "участник", "участника", "участников")} · {numberLabel(project.activeChannels, "канал", "канала", "каналов")}</p>
                            <p className="type-caption mt-0.5 text-text-3">{project.networks.length ? project.networks.map((network) => NETWORK_LABEL[network] || network).join(", ") : "без подключений"}{project.channelAttention > 0 ? ` · ${project.channelAttention} с ошибкой` : ""}</p>
                          </td>
                          <td className="px-4 py-3">
                            <p className="nums type-secondary text-text">{project.postsPeriod} создано · {project.publishedPeriod} вышло</p>
                            <p className="type-caption mt-0.5 text-text-3">{project.scheduled} в плане{project.failedPeriod > 0 ? <span className="text-danger-text"> · {project.failedPeriod} с ошибкой</span> : ""}</p>
                          </td>
                          <td className="px-4 py-3 text-text-2">{project.lastActivityAt ? fmtAgo(project.lastActivityAt) : "—"}</td>
                          <td className="px-4 py-3"><Pill {...pill} /></td>
                          <td className="px-4 py-3 text-end"><Button variant="secondary" size="sm" onClick={(event) => { triggerRef.current = event.currentTarget; setSelectedName(project.name); navigate({ prid: project.id }); }}>Открыть</Button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <ul className="divide-y divide-line lg:hidden">
                {data.projects.map((project) => {
                  const pill = projectState(project);
                  return (
                    <li key={project.id} className="p-4">
                      <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="type-body-strong truncate text-text">{project.name}</p><p className="type-caption mt-0.5 text-text-3">ID {project.id} · {project.owner ?? "без владельца"}</p></div><Pill {...pill} /></div>
                      <p className="type-caption mt-3 text-text-2">{project.members} участников · {project.activeChannels} каналов · {project.postsPeriod} постов за период</p>
                      <Button variant="secondary" className="mt-3 w-full" onClick={(event) => { triggerRef.current = event.currentTarget; setSelectedName(project.name); navigate({ prid: project.id }); }}>Открыть проект</Button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {data.pagination.pages > 1 ? (
            <nav aria-label="Страницы проектов" className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-4 sm:px-5">
              <p className="type-caption text-text-3">Страница {data.pagination.page} из {data.pagination.pages}</p>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" disabled={data.pagination.page <= 1 || listState === "loading"} onClick={() => navigate({ prpage: data.pagination.page - 1 })}><ChevronLeft className="h-4 w-4" aria-hidden />Предыдущая</Button>
                <Button variant="secondary" size="sm" disabled={data.pagination.page >= data.pagination.pages || listState === "loading"} onClick={() => navigate({ prpage: data.pagination.page + 1 })}>Следующая<ChevronRight className="h-4 w-4" aria-hidden /></Button>
              </div>
            </nav>
          ) : null}
        </div>
      ) : null}

      <dialog
        ref={dialogRef}
        aria-labelledby={dialogTitleId}
        onCancel={(event) => { event.preventDefault(); closeDetail(); }}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); closeDetail(); } }}
        onClose={() => { requestAnimationFrame(() => triggerRef.current?.focus()); }}
        onClick={(event) => { if (event.target === event.currentTarget) closeDetail(); }}
        className="m-auto max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-[86rem] overflow-hidden overscroll-contain rounded-lg border border-line bg-surface p-0 text-text shadow-float backdrop:bg-text/45 backdrop:backdrop-blur-sm sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100%-2rem)]"
      >
        <div className="flex max-h-[calc(100dvh-1rem)] flex-col sm:max-h-[calc(100dvh-2rem)]">
          <header className="sticky top-0 z-10 flex shrink-0 items-start justify-between gap-4 border-b border-line bg-surface/95 px-4 py-4 backdrop-blur-md sm:px-6 sm:py-5">
            <div className="min-w-0">
              <p className="type-label text-brand">Карточка проекта</p>
              <h2 id={dialogTitleId} className="mt-1 truncate text-xl font-extrabold tracking-tight text-text sm:text-2xl">{detail?.project.name || selectedName || "Проект"}</h2>
              <p className="type-caption mt-1 text-text-3">Участники, каналы, публикации и журнал — только подтверждённые данные.</p>
            </div>
            <Button autoFocus type="button" variant="ghost" size="icon" className="shrink-0" aria-label="Закрыть карточку проекта" onClick={closeDetail}><X className="h-5 w-5" aria-hidden /></Button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {detailState === "loading" ? <div className="space-y-4 p-6" aria-busy="true"><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 8 }, (_, index) => <div key={index} className="skeleton h-28 rounded-sm" />)}</div><div className="skeleton h-52 rounded-md" /></div> : null}
            {detailState === "ready" && detail ? <DetailContent detail={detail} /> : null}
            {detailState === "error" || detailState === "not_found" ? (
              <div className="grid min-h-72 place-items-center p-6 text-center">
                <div><ShieldAlert className="mx-auto h-8 w-8 text-danger-text" aria-hidden /><h3 className="mt-3 text-text">{detailState === "not_found" ? "Проект не найден" : "Не удалось загрузить карточку"}</h3><Button variant="secondary" className="mt-4" onClick={closeDetail}>Закрыть</Button></div>
              </div>
            ) : null}
          </div>
        </div>
      </dialog>
    </>
  );
}
