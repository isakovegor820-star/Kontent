"use client";

import {
  Activity,
  Bot,
  BriefcaseBusiness,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileText,
  History,
  KeyRound,
  Mail,
  Radio,
  Search,
  Send,
  ShieldAlert,
  ShieldBan,
  ShieldCheck,
  LogOut,
  KeySquare,
  Sparkles,
  UserCheck,
  UserRound,
  Users,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { FormEvent, useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { AdminPeriodDays } from "@/lib/admin-dashboard";
import type {
  AdminUserDetail,
  AdminUserListItem,
  AdminUsersResponse,
  AdminUserSort,
  AdminUserStatusFilter,
} from "@/lib/admin-users";
import { adminUsersHref, adminUsersQuery, type AdminUsersUrlChange } from "@/lib/admin-url-state";
import { cn, fmtAgo, fmtNum, initials, NETWORK_LABEL, plural } from "@/lib/utils";

type ListState = "loading" | "ready" | "error";
type DetailState = "idle" | "loading" | "ready" | "error" | "not_found";

interface UserRequest {
  query: string;
  status: AdminUserStatusFilter;
  network: string;
  sort: AdminUserSort;
  page: number;
  /** Selected account id from `?user=`; 0 when the card is closed. */
  user: number;
}

const STATUS_OPTIONS: Array<{ value: AdminUserStatusFilter; label: string }> = [
  { value: "all", label: "Все аккаунты" },
  { value: "active", label: "Заходили за 30 дней" },
  { value: "attention", label: "Требуют внимания" },
  { value: "new", label: "Новые за период" },
  { value: "onboarding", label: "Не завершили настройку" },
];

const SORT_OPTIONS: Array<{ value: AdminUserSort; label: string }> = [
  { value: "activity_desc", label: "По последнему действию" },
  { value: "registered_desc", label: "Сначала новые регистрации" },
  { value: "posts_desc", label: "По публикациям за период" },
  { value: "ai_desc", label: "По AI за период" },
];

const NETWORK_OPTIONS = ["all", "tg", "vk", "instagram", "youtube", "x", "tiktok", "linkedin"];

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
  published_unverified: "Опубликован, проверка ожидается",
  published: "Опубликован",
  missing: "Не найден в соцсети",
  deleted_external: "Удалён в соцсети",
  failed_retry: "Повторная попытка",
  quarantined: "Карантин",
  failed: "Ошибка",
  cancelled: "Отменён",
};

const VERIFICATION_LABEL: Record<string, string> = {
  verified: "подтверждён",
  unverified: "не проверен",
  missing: "не найден",
  unverifiable: "проверка недоступна",
};

const POST_ORIGIN_LABEL: Record<string, string> = {
  ai: "создан с AI",
  rss: "из RSS",
  retry: "повторная отправка",
  autopilot: "автопилот",
  studio: "из Студии",
  legacy: "ранняя версия",
};

const CHANNEL_STATUS_LABEL: Record<string, string> = {
  active: "Подключён",
  needs_reconnect: "Нужно переподключение",
  permission_lost: "Недостаточно прав",
  revoked: "Доступ отозван",
  disconnected: "Отключён",
};

const AI_KIND_LABEL: Record<string, string> = {
  write: "Создание текста",
  rewrite: "Редактирование",
  shorten: "Сокращение",
  plan: "Контент-план",
  script: "Сценарий",
  image: "Изображение",
  ideas: "Идеи",
  improve: "Улучшение текста",
};

function numberLabel(value: number, one: string, few: string, many: string) {
  return `${fmtNum(value)} ${plural(value, one, few, many)}`;
}

function fullDate(value: string) {
  return new Date(value).toLocaleString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function userState(user: AdminUserListItem) {
  if (user.channelAttention > 0 || user.failedPeriod > 0) {
    return { label: "Требует внимания", tone: "danger" as const, icon: ShieldAlert };
  }
  if (user.activeSessions > 0) {
    return { label: "Заходил за 30 дней", tone: "success" as const, icon: Activity };
  }
  if (!user.onboardingCompleted) {
    return { label: "Настройка не завершена", tone: "warning" as const, icon: Clock3 };
  }
  return { label: "Не заходил 30 дней", tone: "neutral" as const, icon: UserRound };
}

function postState(status: string) {
  if (status === "published") return { tone: "success" as const, icon: CheckCircle2 };
  if (["failed", "missing", "deleted_external"].includes(status)) return { tone: "danger" as const, icon: XCircle };
  if (["failed_retry", "quarantined", "published_unverified"].includes(status)) return { tone: "warning" as const, icon: ShieldAlert };
  if (status === "scheduled" || status === "publishing") return { tone: "brand" as const, icon: Clock3 };
  return { tone: "neutral" as const, icon: Clock3 };
}

function StatusPill({
  label,
  tone,
  icon: Icon,
}: {
  label: string;
  tone: "success" | "danger" | "warning" | "neutral" | "brand";
  icon?: LucideIcon;
}) {
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

function AuthMethods({ auth }: { auth: AdminUserListItem["auth"] | AdminUserDetail["user"]["auth"] }) {
  const methods = [
    { enabled: auth.email, label: "Email", icon: Mail },
    { enabled: auth.password, label: "Пароль", icon: KeyRound },
    { enabled: auth.telegram, label: "Telegram", icon: Send },
    { enabled: auth.vk, label: "VK", icon: Users },
  ].filter((item) => item.enabled);
  if (methods.length === 0) return <span className="type-caption text-text-3">Способ входа не определён</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {methods.map(({ label, icon: Icon }) => (
        <span key={label} className="type-caption inline-flex items-center gap-1 rounded-full bg-surface-inset px-2 py-1 text-text-2">
          <Icon className="h-3.5 w-3.5" aria-hidden />
          {label}
        </span>
      ))}
    </span>
  );
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

function RegistrationBars({ data }: { data: Array<{ date: string; registrations: number }> }) {
  const maximum = Math.max(1, ...data.map((item) => item.registrations));
  const total = data.reduce((sum, item) => sum + item.registrations, 0);
  return (
    <section className="min-w-0 max-w-full rounded-md border border-line bg-surface p-5" aria-labelledby="registrations-chart-title">
      <div>
        <p className="type-label text-brand">Динамика</p>
        <h3 id="registrations-chart-title" className="mt-2 text-text">Новые регистрации</h3>
        <p className="type-caption mt-1 text-text-3">{numberLabel(total, "аккаунт создан", "аккаунта создано", "аккаунтов создано")} за выбранный период</p>
      </div>
      <div className="mt-5 overflow-x-auto pb-2">
        <ul className="flex h-36 min-w-max items-end gap-2" aria-label="Регистрации по дням">
          {data.map((item, index) => {
            const date = new Date(`${item.date}T12:00:00Z`).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
            const showDate = data.length <= 7 || index % 5 === 0 || index === data.length - 1;
            return (
              <li key={item.date} className="flex w-9 shrink-0 flex-col items-center gap-1" aria-label={`${date}: ${numberLabel(item.registrations, "регистрация", "регистрации", "регистраций")}`}>
                <span className="w-6 rounded-t-sm bg-brand" style={{ height: Math.max(item.registrations > 0 ? 8 : 2, (item.registrations / maximum) * 96) }} aria-hidden />
                <span className="type-caption h-4 whitespace-nowrap text-text-3" aria-hidden>{showDate ? date : ""}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

function AccountMaturity({ summary }: { summary: AdminUsersResponse["summary"] }) {
  const rows = [
    { label: "Завершили первичную настройку", value: summary.onboardingComplete, color: "bg-success" },
    { label: "Подключили хотя бы один канал", value: summary.withChannels, color: "bg-brand" },
    { label: "Заходили за последние 30 дней", value: summary.activeAccounts, color: "bg-fire" },
    { label: "Привязали Telegram-чат", value: summary.botLinked, color: "bg-info-text" },
  ];
  return (
    <section className="min-w-0 max-w-full rounded-md border border-line bg-surface p-5" aria-labelledby="accounts-depth-title">
      <p className="type-label text-brand">Глубина активации</p>
      <h3 id="accounts-depth-title" className="mt-2 text-text">Что сделали после регистрации</h3>
      <ul className="mt-5 space-y-4">
        {rows.map((row) => {
          const percentage = summary.accounts > 0 ? Math.round((row.value / summary.accounts) * 100) : 0;
          return (
            <li key={row.label}>
              <div className="type-caption flex items-center justify-between gap-4 text-text-2">
                <span>{row.label}</span>
                <span className="nums shrink-0 font-semibold text-text">{fmtNum(row.value)} · {percentage}%</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-inset" role="progressbar" aria-label={row.label} aria-valuemin={0} aria-valuemax={Math.max(1, summary.accounts)} aria-valuenow={row.value}>
                <span className={cn("block h-full rounded-full", row.color)} style={{ width: `${percentage}%` }} aria-hidden />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ActivityBars({ data }: { data: AdminUserDetail["activity"] }) {
  const maximum = Math.max(1, ...data.flatMap((item) => [item.posts, item.published, item.ai]));
  return (
    <section className="rounded-md border border-line bg-surface p-5" aria-labelledby="user-activity-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="user-activity-title" className="text-text">Динамика активности</h3>
          <p className="type-caption mt-1 text-text-3">Публикации и AI за выбранный период</p>
        </div>
        <div className="type-caption flex flex-wrap gap-3 text-text-2" aria-label="Легенда графика">
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-brand" />Создано</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-success" />Опубликовано</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-fire" />AI</span>
        </div>
      </div>
      <div className="mt-5 overflow-x-auto pb-2">
        <ul className="flex h-40 min-w-max items-end gap-2" aria-label="Активность пользователя по дням">
          {data.map((item, index) => {
            const date = new Date(`${item.date}T12:00:00Z`).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
            const showDate = data.length <= 7 || index % 5 === 0 || index === data.length - 1;
            return (
              <li key={item.date} className="flex w-11 shrink-0 flex-col items-center gap-1" aria-label={`${date}: создано ${item.posts}, опубликовано ${item.published}, AI ${item.ai}`}>
                <div className="flex h-28 items-end gap-0.5" aria-hidden>
                  {[
                    { value: item.posts, color: "bg-brand" },
                    { value: item.published, color: "bg-success" },
                    { value: item.ai, color: "bg-fire" },
                  ].map((bar, barIndex) => (
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

function DetailLoading() {
  return (
    <div className="space-y-5 p-4 sm:p-6" aria-busy="true">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => <div key={index} className="skeleton h-28 rounded-sm" />)}
      </div>
      <div className="skeleton h-52 rounded-md" />
      <p role="status" className="sr-only">Загружаем полную карточку аккаунта…</p>
    </div>
  );
}


const ACCOUNT_ACTION_LABEL: Record<string, string> = {
  "account.blocked": "Аккаунт заблокирован",
  "account.unblocked": "Аккаунт разблокирован",
  "account.sessions_revoked": "Все сессии завершены",
  "account.password_reset_sent": "Отправлена ссылка для сброса пароля",
  "account.ai_limit_changed": "Изменён дневной лимит AI",
};

const ACCOUNT_ACTION_ERROR: Record<string, string> = {
  not_found: "Аккаунт больше не существует.",
  self: "Нельзя применить к собственному аккаунту.",
  protected: "Аккаунт входит в список администраторов — блокировка из панели недоступна.",
  already: "Аккаунт уже в этом состоянии. Обновите карточку.",
  no_email: "У аккаунта нет email — сброс пароля отправить некуда.",
  invalid_limit: "Лимит должен быть целым числом от 1 до 100 000.",
  forbidden_origin: "Запрос отклонён по origin. Обновите страницу.",
  unauthorized: "Сессия истекла. Войдите снова.",
  access_denied: "У сессии нет прав администратора.",
};

function AccountControls({ detail, onChanged }: { detail: AdminUserDetail; onChanged: () => void }) {
  const { user } = detail;
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [pending, setPending] = useState<"block" | "revoke" | null>(null);
  const [reason, setReason] = useState("");
  const [limitInput, setLimitInput] = useState(user.aiDailyLimit == null ? "" : String(user.aiDailyLimit));

  async function perform(action: string, payload: Record<string, unknown>, successText: string) {
    setBusy(action);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/users/${user.id}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...payload }),
      });
      const result = await response.json().catch(() => null) as { status?: string; error?: string } | null;
      if (!response.ok) {
        const code = result?.status ?? result?.error ?? "unavailable";
        throw new Error(ACCOUNT_ACTION_ERROR[code] ?? "Действие не выполнено. Обновите карточку и попробуйте снова.");
      }
      setMessage({ tone: "success", text: successText });
      onChanged();
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Действие не выполнено." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-md border border-line bg-surface p-5" aria-labelledby="account-controls-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="type-label text-brand">Управление</p>
          <h3 id="account-controls-title" className="mt-2 text-text">Действия администратора</h3>
          <p className="type-caption mt-1 text-text-3">Каждое действие записывается в журнал аккаунта с исполнителем и причиной.</p>
        </div>
        {user.blockedAt ? <StatusPill label={`Заблокирован ${fmtAgo(user.blockedAt)}`} tone="danger" icon={ShieldBan} /> : <StatusPill label="Вход разрешён" tone="success" icon={ShieldCheck} />}
      </div>
      {user.blockedReason ? <p className="type-caption mt-3 rounded-sm bg-danger-soft p-3 text-danger-text">Причина: {user.blockedReason}</p> : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" disabled={!user.email} loading={busy === "send_password_reset"} onClick={() => void perform("send_password_reset", {}, `Ссылка для сброса пароля отправлена на ${user.email}.`)} title={user.email ? undefined : "У аккаунта нет email"}>
          <KeySquare className="h-3.5 w-3.5" aria-hidden />Сбросить пароль
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setPending("revoke")}>
          <LogOut className="h-3.5 w-3.5" aria-hidden />Завершить все сессии
        </Button>
        {user.blockedAt ? (
          <Button variant="primary" size="sm" loading={busy === "unblock"} onClick={() => void perform("unblock", {}, "Аккаунт разблокирован. Пользователь может войти снова.")}>
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden />Разблокировать
          </Button>
        ) : (
          <Button variant="danger" size="sm" onClick={() => { setReason(""); setPending("block"); }}>
            <ShieldBan className="h-3.5 w-3.5" aria-hidden />Заблокировать
          </Button>
        )}
      </div>

      <form
        className="mt-5 flex flex-col gap-3 rounded-sm bg-surface-inset p-4 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = limitInput.trim();
          const limit = trimmed === "" ? null : Number(trimmed);
          void perform("set_ai_limit", { limit }, limit === null ? "Лимит AI возвращён к платформенному значению." : `Дневной лимит AI: ${fmtNum(limit)}.`);
        }}
      >
        <label className="block flex-1">
          <span className="type-caption mb-1.5 block text-text-3">Дневной лимит AI-генераций {user.aiDailyLimit == null ? "(сейчас платформенный)" : "(переопределён)"}</span>
          <input type="number" min={1} max={100000} step={1} value={limitInput} onChange={(event) => setLimitInput(event.target.value)} placeholder="Пусто — платформенный лимит" className="min-h-11 w-full rounded-xs border border-line-strong bg-surface px-3.5 text-text" />
        </label>
        <div className="flex gap-2">
          <Button type="submit" variant="secondary" loading={busy === "set_ai_limit"}>Сохранить лимит</Button>
          {user.aiDailyLimit != null ? <Button type="button" variant="ghost" onClick={() => { setLimitInput(""); void perform("set_ai_limit", { limit: null }, "Лимит AI возвращён к платформенному значению."); }}>Сбросить</Button> : null}
        </div>
      </form>

      {message ? <p role="status" className={cn("mt-4 rounded-sm p-3", message.tone === "success" ? "bg-success-soft text-success-text" : "bg-danger-soft text-danger-text")}>{message.text}</p> : null}

      {detail.adminActions.length > 0 ? (
        <ol className="mt-5 space-y-2">
          {detail.adminActions.map((event) => (
            <li key={event.id} className="type-caption flex flex-wrap justify-between gap-2 text-text-2">
              <span><span className="font-semibold text-text">{ACCOUNT_ACTION_LABEL[event.action] ?? event.action}</span> · {event.actor}{event.reason ? ` · ${event.reason}` : ""}</span>
              <time className="text-text-3" dateTime={event.createdAt}>{fmtAgo(event.createdAt)}</time>
            </li>
          ))}
        </ol>
      ) : null}

      <ConfirmDialog
        open={pending === "revoke"}
        title="Завершить все сессии?"
        description={`Пользователь «${user.name}» будет разлогинен на всех устройствах и сможет войти заново. Данные не изменятся.`}
        confirmLabel="Завершить сессии"
        busy={busy === "revoke_sessions"}
        onCancel={() => setPending(null)}
        onConfirm={() => void perform("revoke_sessions", {}, "Все сессии завершены.").then(() => setPending(null))}
      />
      {pending === "block" ? (
        <div role="dialog" aria-modal="true" aria-labelledby="account-block-title" className="fixed inset-0 z-50 grid place-items-center bg-text/45 p-4 backdrop-blur-sm">
          <form
            className="card-plain w-full max-w-md rounded-lg p-6"
            onSubmit={(event) => {
              event.preventDefault();
              void perform("block", { reason: reason.trim() || null }, "Аккаунт заблокирован, все сессии завершены.").then(() => setPending(null));
            }}
          >
            <h3 id="account-block-title" className="text-text">Заблокировать «{user.name}»?</h3>
            <p className="type-secondary mt-2 text-text-2">Вход станет невозможен, все сессии завершатся немедленно. Проекты, каналы и публикации сохранятся; запланированные посты продолжат выходить.</p>
            <label className="mt-4 block">
              <span className="type-caption mb-1.5 block text-text-3">Причина (видна только администраторам)</span>
              <textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={3} className="w-full rounded-xs border border-line-strong bg-surface px-3.5 py-2 text-text" />
            </label>
            <div className="mt-5 flex justify-end gap-3">
              <Button type="button" variant="ghost" onClick={() => setPending(null)}>Отмена</Button>
              <Button type="submit" variant="danger" loading={busy === "block"}>Заблокировать</Button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}

function DetailContent({ detail, onChanged }: { detail: AdminUserDetail; onChanged: () => void }) {
  const { user, summary } = detail;
  return (
    <div className="space-y-10 p-4 sm:p-6">
      <section aria-labelledby="account-summary-title">
        <h3 id="account-summary-title" className="sr-only">Сводка аккаунта</h3>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <SummaryCard label="Проекты" value={summary.projects} helper="Активные членства" icon={BriefcaseBusiness} />
          <SummaryCard label="Каналы" value={summary.channels} helper={`${fmtNum(summary.activeChannels)} активных`} icon={Radio} />
          <SummaryCard label="Публикации" value={summary.posts} helper={`${fmtNum(summary.postsPeriod)} за ${detail.periodDays} дней`} icon={FileText} />
          <SummaryCard label="Опубликовано" value={summary.published} helper={`${fmtNum(summary.scheduled)} запланировано`} icon={Send} />
          <SummaryCard label="Ошибки" value={summary.failed} helper={`${fmtNum(summary.quarantined)} в карантине`} icon={ShieldAlert} />
          <SummaryCard label="Черновики" value={summary.drafts} helper="Сохранённый контент" icon={CalendarDays} />
          <SummaryCard label="AI-операции" value={summary.aiTotal} helper={`${fmtNum(summary.aiPeriod)} за период`} icon={Sparkles} />
          <SummaryCard label="Неистёкшие сессии" value={summary.activeSessions} helper={`${fmtNum(summary.sessions)} входов всего`} icon={Activity} />
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2" aria-labelledby="account-data-title">
        <div className="rounded-md border border-line bg-surface p-5">
          <h3 id="account-data-title" className="text-text">Аккаунт</h3>
          <dl className="mt-5 grid gap-4 sm:grid-cols-2">
            <div><dt className="type-caption text-text-3">Регистрация</dt><dd className="type-secondary mt-1 text-text"><time dateTime={user.createdAt}>{fullDate(user.createdAt)}</time></dd></div>
            <div><dt className="type-caption text-text-3" title="Максимум из последнего входа, публикации и AI-операции; просмотры страниц не учитываются">Последнее действие</dt><dd className="type-secondary mt-1 text-text"><time dateTime={user.lastActivityAt}>{fullDate(user.lastActivityAt)}</time></dd></div>
            <div><dt className="type-caption text-text-3">Первичная настройка</dt><dd className="mt-1"><StatusPill label={user.onboardingCompletedAt ? "Завершена" : "Не завершена"} tone={user.onboardingCompletedAt ? "success" : "warning"} icon={user.onboardingCompletedAt ? CheckCircle2 : Clock3} /></dd></div>
            <div><dt className="type-caption text-text-3">Telegram-чат</dt><dd className="mt-1"><StatusPill label={user.botLinked ? "Привязан" : "Не привязан"} tone={user.botLinked ? "success" : "neutral"} icon={Bot} /></dd></div>
            <div className="sm:col-span-2"><dt className="type-caption text-text-3">Выбранный AI-движок</dt><dd className="type-secondary mt-1 break-words text-text">{user.aiEngine || "Используется настройка платформы"}</dd></div>
          </dl>
        </div>
        <div className="rounded-md border border-line bg-surface p-5">
          <h3 className="text-text">Доступ и подключения</h3>
          <div className="mt-5">
            <p className="type-caption text-text-3">Способы входа</p>
            <div className="mt-2"><AuthMethods auth={user.auth} /></div>
          </div>
          <dl className="mt-5 grid gap-4 sm:grid-cols-2">
            <div><dt className="type-caption text-text-3">Email</dt><dd className="type-secondary mt-1 break-all text-text">{user.email || "Не добавлен"}</dd></div>
            <div><dt className="type-caption text-text-3">ID аккаунта</dt><dd className="nums type-secondary mt-1 text-text">{user.id}</dd></div>
            <div><dt className="type-caption text-text-3">Каналы с ошибкой</dt><dd className="nums type-secondary mt-1 text-text">{summary.channelAttention}</dd></div>
            <div><dt className="type-caption text-text-3">AI сегодня</dt><dd className="nums type-secondary mt-1 text-text">{summary.aiToday}</dd></div>
          </dl>
        </div>
      </section>

      <AccountControls detail={detail} onChanged={onChanged} />

      <ActivityBars data={detail.activity} />

      <section aria-labelledby="projects-detail-title">
        <div>
          <p className="type-label text-brand">Структура работы</p>
          <h3 id="projects-detail-title" className="mt-2 text-text">Проекты и роли</h3>
        </div>
        {detail.projects.length === 0 ? (
          <p className="mt-4 rounded-sm bg-surface-inset p-4 text-text-2">Аккаунт не состоит ни в одном проекте.</p>
        ) : (
          <ul className="mt-5 grid gap-4 lg:grid-cols-2">
            {detail.projects.map((project) => (
              <li key={project.id} className="rounded-md border border-line bg-surface p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="type-body-strong break-words text-text">{project.name}</p>
                    <p className="type-caption mt-1 text-text-3">{project.timezone} · ID {project.id}</p>
                  </div>
                  <StatusPill label={project.status === "active" ? ROLE_LABEL[project.role] || project.role : "Доступ отозван"} tone={project.status === "active" ? "brand" : "neutral"} icon={BriefcaseBusiness} />
                </div>
                <dl className="mt-5 grid grid-cols-3 gap-3">
                  <div><dt className="type-caption text-text-3">Участники</dt><dd className="nums type-body-strong mt-1 text-text">{project.members}</dd></div>
                  <div><dt className="type-caption text-text-3">Каналы</dt><dd className="nums type-body-strong mt-1 text-text">{project.channels}</dd></div>
                  <div><dt className="type-caption text-text-3">Посты</dt><dd className="nums type-body-strong mt-1 text-text">{project.posts}</dd></div>
                </dl>
                <p className="type-caption mt-4 text-text-3">
                  {project.personal ? "Личный проект" : "Командный проект"}{project.archived ? " · Архивирован" : ""} · с <time dateTime={project.joinedAt}>{fullDate(project.joinedAt)}</time>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="channels-detail-title">
        <div>
          <p className="type-label text-brand">Интеграции</p>
          <h3 id="channels-detail-title" className="mt-2 text-text">Подключённые каналы</h3>
        </div>
        {detail.channels.length === 0 ? (
          <p className="mt-4 rounded-sm bg-surface-inset p-4 text-text-2">Каналы ещё не подключены.</p>
        ) : (
          <ul className="mt-5 grid gap-4 xl:grid-cols-2">
            {detail.channels.map((channel) => {
              const healthy = channel.active && channel.status === "active";
              return (
                <li key={channel.id} className="rounded-md border border-line bg-surface p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="type-body-strong break-words text-text">{channel.title}</p>
                      <p className="type-caption mt-1 break-words text-text-3">{NETWORK_LABEL[channel.network] || channel.network} · {channel.project}{channel.handle ? ` · ${channel.handle}` : ""}</p>
                    </div>
                    <StatusPill
                      label={CHANNEL_STATUS_LABEL[channel.status] || channel.status}
                      tone={healthy ? "success" : channel.active ? "danger" : "neutral"}
                      icon={healthy ? CheckCircle2 : channel.active ? ShieldAlert : XCircle}
                    />
                  </div>
                  <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div><dt className="type-caption text-text-3">Посты</dt><dd className="nums type-body-strong mt-1 text-text">{channel.posts}</dd></div>
                    <div><dt className="type-caption text-text-3">Вышло</dt><dd className="nums type-body-strong mt-1 text-text">{channel.published}</dd></div>
                    <div><dt className="type-caption text-text-3">В плане</dt><dd className="nums type-body-strong mt-1 text-text">{channel.scheduled}</dd></div>
                    <div><dt className="type-caption text-text-3">Ошибки</dt><dd className="nums type-body-strong mt-1 text-text">{channel.failed}</dd></div>
                  </dl>
                  <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-text-2">
                    <p className="type-caption">Подписчики: <span className="nums font-semibold text-text">{channel.subscribers == null ? "Нет данных" : fmtNum(channel.subscribers)}</span></p>
                    {channel.subscribersDelta != null ? <p className="type-caption">Изменение: <span className="nums font-semibold text-text">{channel.subscribersDelta > 0 ? "+" : ""}{fmtNum(channel.subscribersDelta)}</span></p> : null}
                    <p className="type-caption">Подключён: <time dateTime={channel.createdAt}>{fullDate(channel.createdAt)}</time></p>
                  </div>
                  {channel.lastAuthErrorCode ? (
                    <p className="type-caption mt-4 rounded-sm bg-danger-soft p-3 font-mono text-danger-text">
                      {channel.lastAuthErrorCode}{channel.lastAuthErrorAt ? ` · ${fmtAgo(channel.lastAuthErrorAt)}` : ""}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="posts-detail-title">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="type-label text-brand">Контент</p>
            <h3 id="posts-detail-title" className="mt-2 text-text">Последние публикации</h3>
          </div>
          <p className="type-caption text-text-3">До 25 последних записей</p>
        </div>
        {detail.posts.length === 0 ? (
          <p className="mt-4 rounded-sm bg-surface-inset p-4 text-text-2">Публикаций ещё нет.</p>
        ) : (
          <div className="mt-5 overflow-hidden rounded-md border border-line bg-surface">
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full min-w-[980px] text-start">
                <thead className="bg-surface-2"><tr><th className="px-4 py-3 text-start">Публикация</th><th className="px-4 py-3 text-start">Канал</th><th className="px-4 py-3 text-start">Статус</th><th className="px-4 py-3 text-start">Результат</th><th className="px-4 py-3 text-start">Время</th></tr></thead>
                <tbody className="divide-y divide-line">
                  {detail.posts.map((post) => {
                    const state = postState(post.status);
                    return (
                    <tr key={post.id} className="align-top">
                      <td className="max-w-md px-4 py-4"><p className="type-secondary line-clamp-2 text-text">{post.text}</p><p className="type-caption mt-1 text-text-3">ID {post.id} · {POST_ORIGIN_LABEL[post.origin] || post.origin}{post.hasMedia ? " · с медиа" : ""}</p>{post.safeErrorCode ? <p className="type-caption mt-1 font-mono text-danger-text">{post.safeErrorCode}</p> : null}</td>
                      <td className="px-4 py-4"><p className="type-secondary font-semibold text-text">{post.channel}</p><p className="type-caption mt-1 text-text-3">{NETWORK_LABEL[post.network] || post.network} · {post.project}</p></td>
                      <td className="px-4 py-4"><StatusPill label={POST_STATUS_LABEL[post.status] || post.status} tone={state.tone} icon={state.icon} /></td>
                      <td className="nums px-4 py-4 text-text-2"><p>{post.views == null ? "Просмотры —" : numberLabel(post.views, "просмотр", "просмотра", "просмотров")}</p><p className="type-caption mt-1 text-text-3">{post.reactions == null ? "Реакции —" : numberLabel(post.reactions, "реакция", "реакции", "реакций")}</p></td>
                      <td className="px-4 py-4"><time className="type-secondary text-text-2" dateTime={post.publishedAt || post.scheduledAt || post.createdAt}>{fullDate(post.publishedAt || post.scheduledAt || post.createdAt)}</time><p className="type-caption mt-1 text-text-3">Попыток: {post.attempts} · проверка: {VERIFICATION_LABEL[post.verificationState] || post.verificationState}</p></td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <ul className="divide-y divide-line lg:hidden">
              {detail.posts.map((post) => {
                const state = postState(post.status);
                return (
                <li key={post.id} className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2"><StatusPill label={POST_STATUS_LABEL[post.status] || post.status} tone={state.tone} icon={state.icon} /><span className="type-caption text-text-3">ID {post.id}</span></div>
                  <p className="type-secondary mt-3 line-clamp-3 text-text">{post.text}</p>
                  <p className="type-caption mt-2 text-text-2">{NETWORK_LABEL[post.network] || post.network} · {post.channel}</p>
                  <p className="type-caption mt-1 text-text-3"><time dateTime={post.publishedAt || post.scheduledAt || post.createdAt}>{fullDate(post.publishedAt || post.scheduledAt || post.createdAt)}</time></p>
                  {post.safeErrorCode ? <p className="type-caption mt-2 font-mono text-danger-text">{post.safeErrorCode}</p> : null}
                </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(20rem,0.75fr)]" aria-labelledby="ai-detail-title">
        <div className="rounded-md border border-line bg-surface p-5">
          <p className="type-label text-brand">Использование</p>
          <h3 id="ai-detail-title" className="mt-2 text-text">Aurora AI</h3>
          {detail.aiKinds.length === 0 ? (
            <p className="mt-4 text-text-2">AI ещё не использовался.</p>
          ) : (
            <ul className="mt-5 grid gap-3 sm:grid-cols-2">
              {detail.aiKinds.map((kind) => (
                <li key={kind.kind} className="rounded-sm bg-surface-inset p-4">
                  <p className="type-secondary font-semibold text-text">{AI_KIND_LABEL[kind.kind] || kind.kind}</p>
                  <p className="nums mt-2 text-xl font-bold text-text">{fmtNum(kind.period)}</p>
                  <p className="type-caption mt-1 text-text-3">за период · {fmtNum(kind.total)} всего</p>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-md border border-line bg-surface p-5">
          <h3 className="text-text">Последние AI-операции</h3>
          {detail.recentAi.length === 0 ? (
            <p className="mt-4 text-text-2">Операций нет.</p>
          ) : (
            <ol className="mt-4 space-y-3">
              {detail.recentAi.map((operation) => (
                <li key={operation.id} className="flex items-start gap-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-info-soft text-info-text"><Sparkles className="h-4 w-4" aria-hidden /></span>
                  <div className="min-w-0"><p className="type-secondary font-semibold text-text">{AI_KIND_LABEL[operation.kind] || operation.kind}</p><p className="type-caption mt-0.5 break-words text-text-3">{operation.contentType || "Текстовый результат"} · <time dateTime={operation.createdAt}>{fmtAgo(operation.createdAt)}</time></p></div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>

      <section className="grid gap-5 xl:grid-cols-2">
        <div className="rounded-md border border-line bg-surface p-5" aria-labelledby="sessions-detail-title">
          <h3 id="sessions-detail-title" className="text-text">История входов</h3>
          <p className="type-caption mt-1 text-text-3">Токены и cookie не отображаются</p>
          {detail.sessions.length === 0 ? <p className="mt-4 text-text-2">Сессий нет.</p> : (
            <ol className="mt-4 space-y-3">
              {detail.sessions.map((session, index) => (
                <li key={`${session.createdAt}-${index}`} className="rounded-sm bg-surface-inset p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2"><p className="type-secondary font-semibold break-words text-text">{session.device}</p><StatusPill label={session.active ? "Активна" : "Завершена"} tone={session.active ? "success" : "neutral"} icon={session.active ? Activity : Clock3} /></div>
                  <p className="type-caption mt-2 text-text-3">Вход: <time dateTime={session.createdAt}>{fullDate(session.createdAt)}</time> · срок до <time dateTime={session.expiresAt}>{fullDate(session.expiresAt)}</time></p>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="rounded-md border border-line bg-surface p-5" aria-labelledby="user-audit-title">
          <h3 id="user-audit-title" className="text-text">Действия пользователя</h3>
          <p className="type-caption mt-1 text-text-3">Только журналируемые события, где аккаунт был исполнителем</p>
          {detail.audit.length === 0 ? <p className="mt-4 text-text-2">Записей нет.</p> : (
            <ol className="mt-4 space-y-3">
              {detail.audit.map((event) => (
                <li key={event.id} className="flex items-start gap-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-surface-inset text-text-2"><History className="h-4 w-4" aria-hidden /></span>
                  <div className="min-w-0"><p className="type-secondary font-semibold break-words text-text">{event.action}</p><p className="type-caption mt-0.5 break-words text-text-3">{event.project} · {event.entityType}{event.entityId ? ` ${event.entityId}` : ""} · <time dateTime={event.createdAt}>{fmtAgo(event.createdAt)}</time></p></div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>
    </div>
  );
}

const DEFAULT_REQUEST: UserRequest = { query: "", status: "all", network: "all", sort: "activity_desc", page: 1, user: 0 };

/** Query string → validated request; unknown values fall back to defaults instead of hitting the API. */
function requestFromSearch(search: string): UserRequest {
  const raw = adminUsersQuery(search);
  const status = STATUS_OPTIONS.some((option) => option.value === raw.status) ? raw.status as AdminUserStatusFilter : "all";
  const sort = SORT_OPTIONS.some((option) => option.value === raw.sort) ? raw.sort as AdminUserSort : "activity_desc";
  const network = NETWORK_OPTIONS.includes(raw.network) ? raw.network : "all";
  const page = Number(raw.page);
  const user = Number(raw.user);
  return {
    query: raw.q.slice(0, 200),
    status,
    network,
    sort,
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    user: Number.isSafeInteger(user) && user > 0 ? user : 0,
  };
}

export function AdminUsersCenter({
  period,
  refreshKey = 0,
  registrations,
}: {
  period: AdminPeriodDays;
  refreshKey?: number;
  registrations: Array<{ date: string; registrations: number }> | null;
}) {
  const [input, setInput] = useState("");
  const [request, setRequest] = useState<UserRequest>(DEFAULT_REQUEST);
  const [urlSynced, setUrlSynced] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [data, setData] = useState<AdminUsersResponse | null>(null);
  const [selectedName, setSelectedName] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchId = useId();
  const dialogTitleId = useId();
  const dialogDescriptionId = useId();

  // Loading states are derived from request identity: a settlement for an older key means
  // the current request is still in flight, so no state needs to be reset inside effects.
  const listParams = new URLSearchParams({
    days: String(period),
    query: request.query,
    status: request.status,
    network: request.network,
    sort: request.sort,
    page: String(request.page),
  }).toString();
  const listKey = `${listParams}:${refreshKey}:${retryKey}`;
  const [listSettled, setListSettled] = useState<{ key: string; ok: boolean; total: number } | null>(null);
  const listState: ListState = !urlSynced || listSettled?.key !== listKey ? "loading" : listSettled.ok ? "ready" : "error";
  const statusMessage = listState === "ready" && listSettled
    ? numberLabel(listSettled.total, "аккаунт найден", "аккаунта найдено", "аккаунтов найдено")
    : listState === "error" ? "Не удалось загрузить аккаунты." : "";

  const [detailRetryKey, setDetailRetryKey] = useState(0);
  const detailKey = request.user ? `${request.user}:${period}:${refreshKey}:${detailRetryKey}` : null;
  const [detailSettled, setDetailSettled] = useState<{ key: string; state: Exclude<DetailState, "idle" | "loading">; detail: AdminUserDetail | null } | null>(null);
  const detailState: DetailState = !detailKey ? "idle" : detailSettled?.key !== detailKey ? "loading" : detailSettled.state;
  // Stale-while-revalidate: after an admin action the card refetches, but the previous
  // payload stays on screen so the confirmation message is not wiped by a skeleton.
  const cachedDetail = detailSettled?.state === "ready" && detailSettled.detail && detailSettled.detail.user.id === request.user
    ? detailSettled.detail : null;
  const detail = detailState === "ready" ? detailSettled?.detail ?? null : cachedDetail;

  // Filters, page and the open account live in the URL: reload, back/forward and shared
  // links reproduce the same screen, and leaving the section no longer resets the search.
  useEffect(() => {
    const sync = () => {
      const next = requestFromSearch(window.location.search);
      setRequest(next);
      setInput(next.query);
      setUrlSynced(true);
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  useEffect(() => {
    if (!urlSynced) return;
    const controller = new AbortController();
    void fetch(`/api/admin/users?${listParams}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("unavailable");
        return response.json() as Promise<AdminUsersResponse>;
      })
      .then((payload) => {
        setData(payload);
        setListSettled({ key: listKey, ok: true, total: payload.pagination.total });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setListSettled({ key: listKey, ok: false, total: 0 });
      });
    return () => controller.abort();
  }, [urlSynced, listParams, listKey]);

  // The open account card follows `?user=<id>`: opening pushes history, closing pops it.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!detailKey) {
      if (dialog?.open) dialog.close();
      return;
    }
    if (dialog && !dialog.open) dialog.showModal();
    const controller = new AbortController();
    void fetch(`/api/admin/users/${request.user}?days=${period}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (response.status === 404) throw new Error("not_found");
        if (!response.ok) throw new Error("unavailable");
        return response.json() as Promise<AdminUserDetail>;
      })
      .then((payload) => {
        setSelectedName(payload.user.name);
        setDetailSettled({ key: detailKey, state: "ready", detail: payload });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setDetailSettled({ key: detailKey, state: error instanceof Error && error.message === "not_found" ? "not_found" : "error", detail: null });
      });
    return () => controller.abort();
  }, [detailKey, request.user, period]);

  function navigate(changes: AdminUsersUrlChange) {
    const href = adminUsersHref(window.location.href, changes);
    window.history.pushState({}, "", href);
    setRequest(requestFromSearch(window.location.search));
  }

  function updateRequest(patch: Partial<Omit<UserRequest, "user">>) {
    navigate({
      ...(patch.query !== undefined ? { q: patch.query } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.network !== undefined ? { network: patch.network } : {}),
      ...(patch.sort !== undefined ? { sort: patch.sort } : {}),
      ...(patch.page !== undefined ? { page: patch.page } : {}),
    });
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    updateRequest({ query: input.trim(), page: 1 });
  }

  function closeDetail() {
    if (request.user) navigate({ user: null });
    else dialogRef.current?.close();
  }

  function openDetail(user: AdminUserListItem, trigger: HTMLButtonElement) {
    triggerRef.current = trigger;
    setSelectedName(user.name);
    navigate({ user: user.id });
  }

  const hasActiveFilters = request.query || request.status !== "all" || request.network !== "all";
  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">{statusMessage}</span>

      {data ? (
        <>
          <div className="grid min-w-0 max-w-full grid-cols-2 gap-3 xl:grid-cols-3 2xl:grid-cols-6">
            <SummaryCard label="Все аккаунты" value={data.summary.accounts} helper="Зарегистрированы в Авроре" icon={Users} />
            <SummaryCard label="Новые" value={data.summary.newAccounts} helper={`За ${data.periodDays} дней`} icon={UserCheck} />
            <SummaryCard label="Заходили за 30 дней" value={data.summary.activeAccounts} helper="Сессия ещё не истекла" icon={Activity} />
            <SummaryCard label="Завершили настройку" value={data.summary.onboardingComplete} helper="Прошли первичную настройку" icon={CheckCircle2} />
            <SummaryCard label="С каналами" value={data.summary.withChannels} helper="Подключили хотя бы один" icon={Radio} />
            <SummaryCard label="Привязали чат" value={data.summary.botLinked} helper="Сохранили связь с Telegram" icon={Bot} />
          </div>
          <div className="mt-5 grid min-w-0 max-w-full gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)]">
            {registrations ? <RegistrationBars data={registrations} /> : <div className="skeleton min-h-56 rounded-md" aria-hidden />}
            <AccountMaturity summary={data.summary} />
          </div>
        </>
      ) : null}

      <div className="mt-5 rounded-md border border-line bg-surface p-4 shadow-soft sm:p-5">
        <form onSubmit={submitSearch} className="grid gap-4 lg:grid-cols-2 lg:items-end 2xl:grid-cols-[minmax(16rem,1fr)_12rem_12rem_minmax(14rem,16rem)_auto]">
          <label htmlFor={searchId} className="block">
            <span className="type-caption mb-1.5 block text-text-3">Поиск аккаунта</span>
            <span className="relative block">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-text-3" aria-hidden />
              <input
                id={searchId}
                name="admin-user-search"
                type="search"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Имя, email, ID или проект"
                className="min-h-11 w-full rounded-xs border border-line-strong bg-surface px-3.5 pl-10 text-base text-text outline-none transition-[border-color,box-shadow] placeholder:text-text-3 focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/20 sm:text-sm"
              />
            </span>
          </label>
          <label className="block">
            <span className="type-caption mb-1.5 block text-text-3">Состояние</span>
            <select value={request.status} onChange={(event) => updateRequest({ status: event.target.value as AdminUserStatusFilter, page: 1 })} className="min-h-11 w-full rounded-xs border border-line-strong bg-surface px-3.5 text-base text-text sm:text-sm">
              {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="type-caption mb-1.5 block text-text-3">Соцсеть</span>
            <select value={request.network} onChange={(event) => updateRequest({ network: event.target.value, page: 1 })} className="min-h-11 w-full rounded-xs border border-line-strong bg-surface px-3.5 text-base text-text sm:text-sm">
              {NETWORK_OPTIONS.map((network) => <option key={network} value={network}>{network === "all" ? "Все соцсети" : NETWORK_LABEL[network] || network}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="type-caption mb-1.5 block text-text-3">Сортировка</span>
            <select value={request.sort} onChange={(event) => updateRequest({ sort: event.target.value as AdminUserSort, page: 1 })} className="min-h-11 w-full rounded-xs border border-line-strong bg-surface px-3.5 text-base text-text sm:text-sm">
              {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <Button type="submit" variant="primary" loading={listState === "loading"} className="lg:col-span-2 2xl:col-span-1">Найти аккаунт</Button>
        </form>
        {hasActiveFilters ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="type-caption text-text-3">Фильтры применены к живым данным платформы.</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setInput("");
                updateRequest({ query: "", status: "all", network: "all", page: 1 });
              }}
            >
              Сбросить фильтры
            </Button>
          </div>
        ) : null}
      </div>

      {listState === "error" && !data ? (
        <div className="mt-5 rounded-md bg-danger-soft p-6 text-center text-danger-text">
          <ShieldAlert className="mx-auto h-7 w-7" aria-hidden />
          <h3 className="mt-3">Не удалось загрузить аккаунты</h3>
          <p className="type-secondary mt-2">Проверьте соединение с базой и повторите загрузку.</p>
          <Button variant="danger" className="mt-4" onClick={() => setRetryKey((value) => value + 1)}>Повторить загрузку</Button>
        </div>
      ) : null}

      {data ? (
        <div className="mt-5 min-w-0 max-w-full overflow-hidden rounded-md border border-line bg-surface shadow-soft" aria-busy={listState === "loading" || undefined}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-4 sm:px-5">
            <div>
              <h3 className="text-text">Аккаунты</h3>
              <p className="type-caption mt-1 text-text-3">{numberLabel(data.pagination.total, "аккаунт", "аккаунта", "аккаунтов")} в выборке · «Посты» — создано / вышло за период</p>
            </div>
            {listState === "loading" ? <StatusPill label="Обновляем данные" tone="brand" icon={Clock3} /> : <StatusPill label="Данные подтверждены" tone="success" icon={CheckCircle2} />}
          </div>
          {data.users.length === 0 ? (
            <div className="p-8 text-center">
              <Search className="mx-auto h-8 w-8 text-text-3" aria-hidden />
              <h3 className="mt-3 text-text">Аккаунты не найдены</h3>
              <p className="type-secondary mt-2 text-text-2">Измените запрос или сбросьте фильтры.</p>
            </div>
          ) : (
            <>
              <div className="hidden max-w-full overflow-x-auto lg:block">
                <table className="w-full text-start">
                  <thead className="bg-surface-2">
                    <tr className="type-caption text-text-3">
                      <th className="px-3 py-2 text-start font-semibold">Аккаунт</th>
                      <th className="px-3 py-2 text-start font-semibold">Вход</th>
                      <th className="px-3 py-2 text-start font-semibold">Проекты · каналы</th>
                      <th className="px-3 py-2 text-end font-semibold">Посты</th>
                      <th className="px-3 py-2 text-end font-semibold">AI</th>
                      <th className="px-3 py-2 text-start font-semibold">Последнее действие</th>
                      <th className="px-3 py-2 text-start font-semibold">Состояние</th>
                      <th className="px-3 py-2" aria-label="Действие" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.users.map((user) => {
                      const state = userState(user);
                      const authMethods = [user.auth.password && "пароль", user.auth.telegram && "Telegram", user.auth.vk && "VK"].filter(Boolean).join(", ") || "email";
                      return (
                        <tr key={user.id} className="align-middle transition-colors duration-150 hover:bg-surface-2/60">
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-2.5">
                              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-info-soft text-xs font-bold text-info-text">{initials(user.name)}</span>
                              <div className="min-w-0">
                                <p className="type-secondary max-w-56 truncate font-semibold text-text" title={user.name}>{user.name}</p>
                                <p className="type-caption max-w-56 truncate text-text-3" title={user.email || undefined}>{user.email || `ID ${user.id}`}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <p className="type-caption text-text-2" title={`Регистрация ${fullDate(user.createdAt)}`}>{authMethods}</p>
                            <p className="type-caption text-text-3">{user.activeSessions > 0 ? `${user.activeSessions} ${plural(user.activeSessions, "сессия", "сессии", "сессий")}` : "нет сессий"}</p>
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <p className="nums type-caption text-text-2">{user.projects} · {user.channels}</p>
                            <p className="type-caption text-text-3">{user.networks.length ? user.networks.map((network) => NETWORK_LABEL[network] || network).join(", ") : "без подключений"}{user.channelAttention > 0 ? <span className="text-danger-text"> · {user.channelAttention} с ошибкой</span> : null}</p>
                          </td>
                          <td className="nums px-3 py-2 text-end whitespace-nowrap">
                            <p className="type-caption text-text-2">{user.postsPeriod} / {user.publishedPeriod}</p>
                            <p className="type-caption text-text-3">{user.scheduled} в плане{user.failedPeriod > 0 ? <span className="text-danger-text"> · {user.failedPeriod} ошиб.</span> : null}</p>
                          </td>
                          <td className="nums px-3 py-2 text-end whitespace-nowrap">
                            <p className="type-caption text-text-2">{user.aiPeriod}</p>
                            <p className="type-caption text-text-3">{user.aiTotal} всего</p>
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap text-text-2"><span className="type-caption" title={fullDate(user.lastActivityAt)}>{fmtAgo(user.lastActivityAt)}</span></td>
                          <td className="px-3 py-2"><StatusPill {...state} /></td>
                          <td className="px-3 py-2 text-end"><Button variant="secondary" size="sm" onClick={(event) => openDetail(user, event.currentTarget)}>Открыть</Button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <ul className="divide-y divide-line lg:hidden">
                {data.users.map((user) => {
                  const state = userState(user);
                  return (
                    <li key={user.id} className="p-4 sm:p-5">
                      <div className="flex items-start gap-3"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-sm bg-info-soft font-bold text-info-text">{initials(user.name)}</span><div className="min-w-0 flex-1"><p className="type-body-strong truncate text-text">{user.name}</p><p className="type-caption mt-1 truncate text-text-3">{user.email || `ID ${user.id}`}</p></div></div>
                      <div className="mt-3"><StatusPill {...state} /></div>
                      <dl className="mt-4 grid grid-cols-2 gap-3"><div className="rounded-sm bg-surface-inset p-3"><dt className="type-caption text-text-3">Проекты / каналы</dt><dd className="nums type-secondary mt-1 font-semibold text-text">{user.projects} / {user.channels}</dd></div><div className="rounded-sm bg-surface-inset p-3"><dt className="type-caption text-text-3">Посты / AI</dt><dd className="nums type-secondary mt-1 font-semibold text-text">{user.postsPeriod} / {user.aiPeriod}</dd></div></dl>
                      <p className="type-caption mt-3 text-text-3">Регистрация: <time dateTime={user.createdAt}>{fullDate(user.createdAt)}</time></p>
                      <Button variant="secondary" className="mt-4 w-full" onClick={(event) => openDetail(user, event.currentTarget)}>Открыть аккаунт</Button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {data.pagination.pages > 1 ? (
            <nav aria-label="Страницы аккаунтов" className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-4 sm:px-5">
              <p className="type-caption text-text-3">Страница {data.pagination.page} из {data.pagination.pages}</p>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" disabled={request.page <= 1 || listState === "loading"} onClick={() => updateRequest({ page: request.page - 1 })}><ChevronLeft className="h-4 w-4" aria-hidden />Предыдущая</Button>
                <Button variant="secondary" size="sm" disabled={request.page >= data.pagination.pages || listState === "loading"} onClick={() => updateRequest({ page: request.page + 1 })}>Следующая<ChevronRight className="h-4 w-4" aria-hidden /></Button>
              </div>
            </nav>
          ) : null}
        </div>
      ) : null}

      <dialog
        ref={dialogRef}
        aria-labelledby={dialogTitleId}
        aria-describedby={dialogDescriptionId}
        onCancel={(event) => {
          event.preventDefault();
          closeDetail();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          closeDetail();
        }}
        onClose={() => {
          requestAnimationFrame(() => triggerRef.current?.focus());
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeDetail();
        }}
        className="m-auto max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-[86rem] overflow-hidden overscroll-contain rounded-lg border border-line bg-surface p-0 text-text shadow-float backdrop:bg-text/45 backdrop:backdrop-blur-sm sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100%-2rem)]"
      >
        <div className="flex max-h-[calc(100dvh-1rem)] flex-col sm:max-h-[calc(100dvh-2rem)]">
          <header className="sticky top-0 z-10 flex shrink-0 items-start justify-between gap-4 border-b border-line bg-surface/95 px-4 py-4 backdrop-blur-md sm:px-6 sm:py-5">
            <div className="min-w-0">
              <p className="type-label text-brand">Полная карточка аккаунта</p>
              <h2 id={dialogTitleId} className="mt-1 truncate text-xl font-extrabold tracking-tight text-text sm:text-2xl">{detail?.user.name || selectedName || "Аккаунт"}</h2>
              <p id={dialogDescriptionId} className="type-caption mt-1 max-w-3xl text-pretty text-text-3">Регистрация, доступ, проекты, каналы, публикации, AI, сессии и действия — только подтверждённые данные.</p>
            </div>
            <Button autoFocus type="button" variant="ghost" size="icon" className="shrink-0" aria-label="Закрыть карточку аккаунта" onClick={closeDetail}><X className="h-5 w-5" aria-hidden /></Button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {detailState === "loading" && !detail ? <DetailLoading /> : null}
            {detail ? <DetailContent detail={detail} onChanged={() => setDetailRetryKey((value) => value + 1)} /> : null}
            {detailState === "error" || detailState === "not_found" ? (
              <div className="grid min-h-72 place-items-center p-6 text-center">
                <div><ShieldAlert className="mx-auto h-8 w-8 text-danger-text" aria-hidden /><h3 className="mt-3 text-text">{detailState === "not_found" ? "Аккаунт больше не существует" : "Не удалось загрузить карточку"}</h3><p className="type-secondary mt-2 text-text-2">Закройте карточку и повторите попытку.</p><Button variant="secondary" className="mt-4" onClick={closeDetail}>Закрыть карточку</Button></div>
              </div>
            ) : null}
          </div>
        </div>
      </dialog>
    </>
  );
}
