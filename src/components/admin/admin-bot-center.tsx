"use client";

import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  BotOff,
  BriefcaseBusiness,
  CheckCircle2,
  Clock3,
  Command,
  ExternalLink,
  Headphones,
  MessageSquareText,
  MessageCircleQuestion,
  MousePointerClick,
  RefreshCw,
  Send,
  Settings2,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Users,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button, buttonClassName } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { AdminBotData } from "@/lib/admin-bot";
import type { AdminPeriodDays } from "@/lib/admin-dashboard";
import { cn, fmtAgo, fmtNum, plural } from "@/lib/utils";

type AccessTarget = { type: "user" | "project"; id: number; name: string };

const ACTION_LABEL: Record<string, string> = {
  "bot.access.enabled": "Доступ к боту включён",
  "bot.access.disabled": "Доступ к боту приостановлен",
  "bot.business.enabled": "Помощник клиентам включён",
  "bot.business.disabled": "Помощник клиентам выключен",
  "bot.test.delivered": "Тестовое сообщение доставлено",
  "bot.test.failed": "Тестовое сообщение не доставлено",
  "draft.saved_from_bot": "Черновик создан в боте",
  "publication.scheduled_from_bot": "Публикация поставлена из бота",
  "editorial.submitted_from_bot": "Материал отправлен на согласование",
  "editorial.decided_from_bot": "Решение по материалу принято",
};

const DELIVERY_SOURCE: Record<string, string> = {
  assistant: "Ассистент",
  admin_test: "Проверка администратора",
  telegram_channel: "Публикация в канал",
};

const BOT_ACTION_LABEL: Record<string, string> = {
  start: "Запуск и подключение",
  menu: "Главное меню",
  status: "Статус подключения",
  connect: "Подключение аккаунта",
  projects: "Выбор проекта",
  today: "Сводка на сегодня",
  create: "Создание публикации",
  approvals: "Согласования",
  problems: "Проблемы",
  results: "Результаты публикаций",
  calendar: "Календарь",
  stats: "Статистика",
  plan: "План недели",
  trends: "Тренды",
  notifications: "Настройки уведомлений",
  disconnect: "Отключение чата",
  cancel: "Отмена действия",
  help: "Справка",
  free_text: "Свободный текст",
  voice_message: "Голосовое сообщение",
  media_attachment: "Файл или фотография",
  "connection:status": "Проверка подключения",
  "connection:projects": "Список проектов",
  "connection:project": "Выбор проекта",
  "connection:disconnect": "Отключение чата",
  "connection:disconnect_confirm": "Подтверждение отключения",
};

const INTERACTION_TYPE_LABEL: Record<string, string> = {
  command: "Команда",
  reply_button: "Кнопка меню",
  callback: "Кнопка в сообщении",
  message: "Сообщение",
  voice: "Голос",
  attachment: "Вложение",
};

function botActionLabel(type: string, action: string) {
  const known = BOT_ACTION_LABEL[action];
  if (known) return known;
  if (type === "command") return `/${action}`;
  return action.replace(/[_:]+/gu, " ");
}

function numberLabel(value: number, one: string, few: string, many: string) {
  return `${fmtNum(value)} ${plural(value, one, few, many)}`;
}

function StatusPill({
  state,
  label,
}: {
  state: "healthy" | "warning" | "danger" | "neutral";
  label: string;
}) {
  const Icon = state === "healthy" ? CheckCircle2 : state === "danger" ? XCircle : state === "warning" ? AlertTriangle : Clock3;
  return (
    <span className={cn(
      "type-caption inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 font-semibold whitespace-nowrap",
      state === "healthy" && "bg-success-soft text-success-text",
      state === "danger" && "bg-danger-soft text-danger-text",
      state === "warning" && "bg-fire-soft text-fire-text",
      state === "neutral" && "bg-surface-inset text-text-2",
    )}>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {label}
    </span>
  );
}

function BotMetric({
  label,
  value,
  helper,
  icon: Icon,
  danger = false,
}: {
  label: string;
  value: number;
  helper: string;
  icon: LucideIcon;
  danger?: boolean;
}) {
  return (
    <article className="card-plain rounded-md p-5">
      <div className="flex items-start justify-between gap-4">
        <p className="type-label text-text-2">{label}</p>
        <span className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-sm", danger ? "bg-danger-soft text-danger-text" : "bg-info-soft text-info-text")}>
          <Icon className="h-5 w-5" strokeWidth={1.8} aria-hidden />
        </span>
      </div>
      <p className="nums mt-5 text-[clamp(1.75rem,4vw,2.5rem)] font-bold leading-none tracking-[-0.035em] text-text">{fmtNum(value)}</p>
      <p className="type-caption mt-2 text-pretty text-text-3">{helper}</p>
    </article>
  );
}

function ActivityChart({ data }: { data: AdminBotData["daily"] }) {
  const maximum = Math.max(1, ...data.flatMap((item) => [item.interactions, item.drafts, item.scheduled, item.published, item.failures]));
  return (
    <section className="card-plain min-w-0 max-w-full rounded-md p-5 sm:p-6" aria-labelledby="bot-activity-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 id="bot-activity-title" className="text-text">Активность по дням</h3>
          <p className="type-caption mt-1 text-text-3">Путь от черновика до подтверждённой публикации</p>
        </div>
        <div className="type-caption flex flex-wrap gap-3 text-text-2" aria-label="Легенда графика">
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-info" />Действия</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-brand" />Черновики</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-fire" />В очередь</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-success" />Опубликовано</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-danger" />Ошибки</span>
        </div>
      </div>
      <div className="mt-6 overflow-x-auto pb-2">
        <ul className="flex h-48 min-w-max items-end gap-2" aria-label="Активность Telegram-бота по дням">
          {data.map((item, index) => {
            const date = new Date(`${item.date}T12:00:00Z`).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
            const showDate = data.length <= 7 || index % 5 === 0 || index === data.length - 1;
            return (
              <li key={item.date} className="flex w-14 shrink-0 flex-col items-center gap-1" aria-label={`${date}: действия ${item.interactions}, черновики ${item.drafts}, в очередь ${item.scheduled}, опубликовано ${item.published}, ошибки ${item.failures}`}>
                <div className="flex h-36 items-end gap-0.5" aria-hidden>
                  {[
                    { value: item.interactions, className: "bg-info" },
                    { value: item.drafts, className: "bg-brand" },
                    { value: item.scheduled, className: "bg-fire" },
                    { value: item.published, className: "bg-success" },
                    { value: item.failures, className: "bg-danger" },
                  ].map((bar, barIndex) => (
                    <span key={barIndex} className={cn("w-2 rounded-t-sm", bar.className)} style={{ height: Math.max(bar.value > 0 ? 7 : 2, (bar.value / maximum) * 132) }} />
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

function NotificationCoverage({ data }: { data: AdminBotData["notifications"] }) {
  const rows = [
    ["Успешные публикации", data.publicationSuccess],
    ["Ошибки публикации", data.publicationFailure],
    ["Идеи и тренды", data.opportunities],
    ["Результаты постов", data.postResults],
    ["Напоминания о согласовании", data.reviewReminders],
    ["Сводка проблем", data.problemDigest],
    ["Ежедневная сводка", data.dailyDigest],
    ["Еженедельный итог", data.weeklyDigest],
  ] as const;
  return (
    <section className="card-plain min-w-0 max-w-full rounded-md p-5 sm:p-6" aria-labelledby="notification-coverage-title">
      <h3 id="notification-coverage-title" className="text-text">Настройки уведомлений</h3>
      <p className="type-caption mt-1 text-text-3">Сколько проектных профилей получают каждый тип сообщений</p>
      {data.recipients === 0 ? (
        <div className="mt-5 rounded-sm bg-surface-inset p-5 text-center">
          <Settings2 className="mx-auto h-7 w-7 text-text-3" aria-hidden />
          <p className="type-body-strong mt-3 text-text">Настройки появятся после первого входа в бот</p>
          <p className="type-caption mt-1 text-text-3">Пользователь сам выбирает нужные уведомления в Telegram.</p>
        </div>
      ) : (
        <ul className="mt-5 grid gap-4 sm:grid-cols-2">
          {rows.map(([label, value]) => {
            const percentage = Math.round((value / data.recipients) * 100);
            return (
              <li key={label}>
                <div className="type-caption flex items-center justify-between gap-3 text-text-2">
                  <span>{label}</span>
                  <span className="nums shrink-0 font-semibold text-text">{fmtNum(value)} · {percentage}%</span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-inset" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={data.recipients} aria-valuenow={value}>
                  <span className="block h-full rounded-full bg-brand" style={{ width: `${percentage}%` }} aria-hidden />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function UsageOverview({ data }: { data: AdminBotData }) {
  const categories = [
    { label: "Команды", value: data.summary.commandInteractions, icon: Command },
    { label: "Кнопки", value: data.summary.buttonInteractions, icon: MousePointerClick },
    { label: "Текст, голос и файлы", value: data.summary.messageInteractions, icon: MessageSquareText },
  ] as const;
  const maximum = Math.max(1, data.summary.interactions);

  return (
    <section className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]" aria-labelledby="bot-usage-title">
      <div className="card-plain rounded-md p-5 sm:p-6">
        <p className="type-label text-brand">Использование</p>
        <h3 id="bot-usage-title" className="mt-2 text-text">Как работают с ботом</h3>
        <p className="type-caption mt-1 max-w-xl text-pretty text-text-3">Считаются только тип действия и раздел. Тексты сообщений, идентификаторы кнопок и токены не сохраняются.</p>
        <ul className="mt-6 space-y-5">
          {categories.map(({ label, value, icon: Icon }) => {
            const percentage = Math.round((value / maximum) * 100);
            return (
              <li key={label}>
                <div className="flex items-center gap-3">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-sm bg-info-soft text-info-text">
                    <Icon className="h-5 w-5" strokeWidth={1.8} aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="type-caption flex items-center justify-between gap-3 text-text-2">
                      <span>{label}</span>
                      <span className="nums shrink-0 font-semibold text-text">{fmtNum(value)} · {percentage}%</span>
                    </div>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-inset" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={maximum} aria-valuenow={value}>
                      <span className="block h-full rounded-full bg-info" style={{ width: `${percentage}%` }} aria-hidden />
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="card-plain rounded-md p-5 sm:p-6">
        <h3 className="text-text">Популярные действия</h3>
        <p className="type-caption mt-1 text-text-3">Что открывали и запускали за выбранный период</p>
        {data.topActions.length === 0 ? (
          <div className="mt-5 rounded-sm bg-surface-inset p-5 text-center">
            <Activity className="mx-auto h-7 w-7 text-text-3" aria-hidden />
            <p className="type-body-strong mt-3 text-text">Новых действий пока нет</p>
            <p className="type-caption mt-1 text-text-3">Они появятся после следующей команды или нажатия в Telegram.</p>
          </div>
        ) : (
          <ol className="mt-5 grid gap-3 sm:grid-cols-2">
            {data.topActions.slice(0, 10).map((item, index) => (
              <li key={`${item.type}:${item.action}`} className="flex items-center gap-3 rounded-sm bg-surface-inset p-3">
                <span className="nums grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface text-text-2" aria-hidden>{index + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="type-secondary truncate font-semibold text-text">{botActionLabel(item.type, item.action)}</p>
                  <p className="type-caption mt-0.5 text-text-3">{INTERACTION_TYPE_LABEL[item.type] || "Действие"}</p>
                </div>
                <span className="nums shrink-0 font-semibold text-text">{fmtNum(item.count)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function BotCenterLoading() {
  return (
    <div className="space-y-5" aria-busy="true">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => <div key={index} className="skeleton h-36 rounded-md" />)}
      </div>
      <div className="skeleton h-72 rounded-md" />
      <p className="sr-only" role="status">Загружаем данные Telegram-бота…</p>
    </div>
  );
}

export function AdminBotCenter({ period }: { period: AdminPeriodDays }) {
  const [data, setData] = useState<AdminBotData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [confirmTarget, setConfirmTarget] = useState<AccessTarget | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/admin/bot?days=${period}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("load_failed");
        return response.json() as Promise<AdminBotData>;
      })
      .then(setData)
      .catch(() => {
        if (!controller.signal.aborted) setLoadError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [period, refreshKey]);

  const runtimeState = useMemo(() => {
    if (!data) return "neutral" as const;
    if (data.runtime.state === "healthy" && data.workerState === "up") return "healthy" as const;
    if (data.runtime.state === "not_configured" || data.workerState === "unknown") return "warning" as const;
    return "danger" as const;
  }, [data]);

  async function performAction(payload: Record<string, unknown>, key: string, successMessage: string) {
    setActionKey(key);
    setMessage("");
    try {
      const response = await fetch("/api/admin/bot/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => null) as { status?: string; description?: string } | null;
      if (!response.ok) {
        const copy = result?.status === "not_linked" ? "Пользователь ещё не подключил чат к боту."
          : result?.status === "disabled" ? "Сначала включите пользователю доступ к боту."
            : result?.status === "not_configured" ? "Сначала подключите безопасный токен бота."
              : result?.status === "not_connected" ? "Telegram Business ещё не подключён к этому проекту."
                : result?.description || "Действие не выполнено. Обновите данные и попробуйте снова.";
        throw new Error(copy);
      }
      setMessage(successMessage);
      setLoading(true);
      setLoadError(false);
      setRefreshKey((value) => value + 1);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Действие не выполнено. Попробуйте снова.");
    } finally {
      setActionKey(null);
    }
  }

  if (loading && !data) return <BotCenterLoading />;
  if (!data) {
    return (
      <div className="card-plain rounded-md p-7 text-center">
        <BotOff className="mx-auto h-9 w-9 text-danger-text" aria-hidden />
        <h3 className="mt-3 text-text">Не удалось загрузить управление ботом</h3>
        <p className="type-secondary mx-auto mt-2 max-w-lg text-pretty text-text-2">Проверьте базу и состояние воркера, затем повторите загрузку.</p>
        <Button className="mt-5" variant="primary" onClick={() => {
          setLoading(true);
          setLoadError(false);
          setRefreshKey((value) => value + 1);
        }}>
          <RefreshCw className="h-4 w-4" aria-hidden />
          Повторить загрузку
        </Button>
      </div>
    );
  }

  return (
    <div className="min-w-0 max-w-full space-y-8">
      <div className={cn(
        "rounded-lg border p-5 shadow-soft sm:p-6",
        runtimeState === "healthy" ? "border-success/20 bg-success-soft" : runtimeState === "danger" ? "border-danger/20 bg-danger-soft" : "border-fire/25 bg-fire-soft",
      )}>
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <StatusPill
              state={runtimeState}
              label={runtimeState === "healthy"
                ? "Бот принимает сообщения"
                : data.runtime.state === "not_configured"
                  ? "Токен не подключён"
                  : data.runtime.state === "healthy"
                    ? data.workerState === "conflict"
                      ? "Найден второй воркер"
                      : "Приём сообщений остановлен"
                    : "Telegram API недоступен"}
            />
            <h3 className="mt-4 text-text">{data.runtime.botName || "Telegram-бот Авроры"}</h3>
            <p className="type-secondary mt-2 max-w-2xl text-pretty text-text-2">
              {data.runtime.username
                ? data.workerState === "up"
                  ? `@${data.runtime.username} принимает кнопки, уведомления и редакционные действия.`
                  : data.workerState === "conflict"
                    ? `@${data.runtime.username} одновременно слушает второй процесс. Остановите его или замените токен.`
                    : `@${data.runtime.username} зарегистрирован, но входящие сообщения сейчас не обрабатываются.`
                : "Имя бота появится после успешной проверки токена через Telegram."}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <StatusPill state={data.runtime.state === "healthy" ? "healthy" : "danger"} label={data.runtime.state === "healthy" ? "Telegram API доступен" : "Telegram API недоступен"} />
              <StatusPill
                state={data.workerState === "up" ? "healthy" : data.workerState === "unknown" ? "warning" : "danger"}
                label={data.workerState === "up"
                  ? "Приём сообщений работает"
                  : data.workerState === "conflict"
                    ? "Конфликт двух воркеров"
                    : data.workerState === "unknown"
                      ? "Состояние приёма не подтверждено"
                      : "Приём сообщений остановлен"}
              />
              <StatusPill state={data.publicationWorkerState === "up" ? "healthy" : data.publicationWorkerState === "unknown" ? "warning" : "danger"} label={data.publicationWorkerState === "up" ? "Публикации работают" : "Публикации не подтверждены"} />
              <StatusPill state={data.runtime.miniAppReady ? "healthy" : "warning"} label={data.runtime.miniAppReady ? "Mini App готов" : "Mini App ждёт HTTPS"} />
              <StatusPill state={data.runtime.voiceReady ? "healthy" : "warning"} label={data.runtime.voiceReady ? "Голос доступен" : "Распознавание не настроено"} />
            </div>
            <p className="type-caption mt-3 text-text-3">
              Проверено {fmtAgo(data.checkedAt)}
              {data.summary.lastInteractionAt ? ` · последнее действие ${fmtAgo(data.summary.lastInteractionAt)}` : " · действий после включения журнала ещё не было"}
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row lg:flex-col">
            {data.runtime.username ? (
              <Link href={`https://t.me/${data.runtime.username}`} target="_blank" rel="noreferrer" className={buttonClassName({ variant: "primary" })}>
                Открыть бота
                <ExternalLink className="h-4 w-4" aria-hidden />
              </Link>
            ) : null}
            <Button variant="secondary" loading={loading} onClick={() => {
              setLoading(true);
              setLoadError(false);
              setRefreshKey((value) => value + 1);
            }}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              Обновить состояние
            </Button>
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <BotMetric label="Активны в боте" value={data.summary.activeUsers} helper={`За последние ${period} дней`} icon={Users} />
        <BotMetric label="Действия в боте" value={data.summary.interactions} helper="Команды, кнопки, сообщения и голос" icon={Activity} />
        <BotMetric label="Команды" value={data.summary.commandInteractions} helper="Команды из меню Telegram" icon={Command} />
        <BotMetric label="Нажатия кнопок" value={data.summary.buttonInteractions} helper="Меню и кнопки под сообщениями" icon={MousePointerClick} />
        <BotMetric label="Подключили бота" value={data.summary.linkedUsers} helper={`${fmtNum(data.summary.disabledUsers)} с приостановленным доступом`} icon={Users} />
        <BotMetric label="Черновики из бота" value={data.summary.draftsCreated} helper={`За последние ${period} дней`} icon={Sparkles} />
        <BotMetric label="Поставлено в очередь" value={data.summary.publicationsScheduled} helper={`${fmtNum(data.summary.publicationsPublished)} уже опубликовано`} icon={Send} />
        <BotMetric label="Ошибки доставки" value={data.summary.deliveryFailures} helper={`За последние ${period} дней`} icon={AlertTriangle} danger={data.summary.deliveryFailures > 0} />
        <BotMetric label="Активные проекты" value={data.summary.activeProjects} helper={`${fmtNum(data.summary.disabledProjects)} приостановлено только в боте`} icon={BriefcaseBusiness} />
        <BotMetric label="Ожидают результат" value={data.summary.pendingResults} helper="Уведомления о результатах постов" icon={Clock3} />
        <BotMetric label="Telegram Business" value={data.summary.businessEnabled} helper={`${fmtNum(data.summary.businessConnected)} подключено`} icon={Headphones} />
        <BotMetric label="Вопросы клиентов" value={data.summary.openClientInquiries} helper="Ждут черновика или решения человека" icon={MessageCircleQuestion} danger={data.summary.openClientInquiries > 0} />
      </div>

      <div className="grid min-w-0 max-w-full gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(22rem,0.85fr)]">
        <ActivityChart data={data.daily} />
        <NotificationCoverage data={data.notifications} />
      </div>

      <UsageOverview data={data} />

      <section aria-labelledby="bot-users-title">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="type-label text-brand">Аккаунты</p>
            <h3 id="bot-users-title" className="mt-2 text-text">Пользователи бота</h3>
            <p className="type-secondary mt-2 max-w-2xl text-pretty text-text-2">Привязка чата, активность, последняя доставка и безопасное bot-only управление доступом.</p>
          </div>
          <span className="type-caption text-text-3">{numberLabel(data.users.length, "аккаунт показан", "аккаунта показано", "аккаунтов показано")}</span>
        </div>
        {data.users.length === 0 ? (
          <div className="card-plain mt-5 rounded-md p-8 text-center">
            <Smartphone className="mx-auto h-8 w-8 text-text-3" aria-hidden />
            <h4 className="mt-3 text-text">Никто ещё не подключил бота</h4>
            <p className="type-secondary mt-2 text-text-2">Аккаунты появятся здесь после перехода по персональной ссылке из настроек Авроры.</p>
          </div>
        ) : (
          <ul className="mt-5 grid gap-4 xl:grid-cols-2">
            {data.users.map((user) => (
              <li key={user.id} className="card-plain rounded-md p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="truncate text-text">{user.name}</h4>
                    <p className="type-caption mt-1 truncate text-text-3">{user.email || `Аккаунт №${user.id}`}</p>
                  </div>
                  <StatusPill state={!user.enabled ? "danger" : user.linked ? "healthy" : "warning"} label={!user.enabled ? "Доступ приостановлен" : user.linked ? "Чат подключён" : "Чат не подключён"} />
                </div>
                {user.disabledReason ? <p className="type-caption mt-3 rounded-sm bg-danger-soft p-3 text-danger-text">Причина: {user.disabledReason}</p> : null}
                <dl className="mt-4 grid grid-cols-2 gap-3 rounded-sm bg-surface-inset p-4 sm:grid-cols-4">
                  {[
                    ["Проекты", user.projects], ["Профили", user.notificationProfiles],
                    ["Действия", user.interactions], ["Команды", user.commands],
                    ["Кнопки", user.buttons], ["Сообщения", user.messages],
                    ["Черновики", user.draftsCreated], ["В очередь", user.publicationsScheduled],
                  ].map(([label, value]) => (
                    <div key={String(label)}><dt className="type-caption text-text-3">{label}</dt><dd className="nums mt-1 font-semibold text-text">{fmtNum(Number(value))}</dd></div>
                  ))}
                </dl>
                <div className="type-caption mt-4 flex flex-wrap gap-x-5 gap-y-2 text-text-3">
                  <span>В боте: {user.lastInteractionAt ? fmtAgo(user.lastInteractionAt) : "ещё не работал"}</span>
                  <span>Результативное действие: {user.lastActivityAt ? fmtAgo(user.lastActivityAt) : "ещё не было"}</span>
                  <span>Доставка: {user.lastDeliveryAt ? `${user.lastDeliveryOk ? "успешно" : "ошибка"}, ${fmtAgo(user.lastDeliveryAt)}` : "не проверялась"}</span>
                </div>
                <div className="mt-4 flex flex-wrap gap-3">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!user.linked || !user.enabled}
                    loading={actionKey === `test-user-${user.id}`}
                    onClick={() => void performAction({ action: "test_delivery", targetUserId: user.id }, `test-user-${user.id}`, `Тестовое сообщение для «${user.name}» доставлено.`)}
                  >
                    <Send className="h-4 w-4" aria-hidden />
                    Проверить доставку
                  </Button>
                  {user.enabled ? (
                    <Button variant="danger" size="sm" onClick={() => setConfirmTarget({ type: "user", id: user.id, name: user.name })}>Приостановить доступ</Button>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={actionKey === `enable-user-${user.id}`}
                      onClick={() => void performAction({ action: "set_access", targetType: "user", targetId: user.id, enabled: true }, `enable-user-${user.id}`, `Доступ пользователя «${user.name}» к боту восстановлен.`)}
                    >Включить доступ</Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="bot-projects-title">
        <p className="type-label text-brand">Проекты</p>
        <h3 id="bot-projects-title" className="mt-2 text-text">Каналы и Telegram Business</h3>
        <p className="type-secondary mt-2 max-w-2xl text-pretty text-text-2">Клиентский помощник всегда сохраняет ответ как черновик и требует подтверждения человека.</p>
        {data.projects.length === 0 ? (
          <div className="card-plain mt-5 rounded-md p-8 text-center text-text-2">Проекты с Telegram-активностью пока не найдены.</div>
        ) : (
          <div className="mt-5 overflow-hidden rounded-md border border-line bg-surface shadow-soft">
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full min-w-[980px] text-start">
                <thead className="bg-surface-2"><tr>
                  <th className="px-5 py-3 text-start">Проект</th><th className="px-5 py-3 text-start">Доступ</th>
                  <th className="px-5 py-3 text-start">Активность</th><th className="px-5 py-3 text-start">Telegram Business</th><th className="px-5 py-3 text-start">Действия</th>
                </tr></thead>
                <tbody className="divide-y divide-line">
                  {data.projects.map((project) => (
                    <tr key={project.id} className="align-top">
                      <td className="px-5 py-4"><p className="type-body-strong text-text">{project.name}</p><p className="type-caption mt-1 text-text-3">{numberLabel(project.linkedMembers, "участник", "участника", "участников")} · {numberLabel(project.telegramChannels, "канал", "канала", "каналов")}</p></td>
                      <td className="px-5 py-4"><StatusPill state={project.enabled ? "healthy" : "danger"} label={project.enabled ? "Доступен в боте" : "Приостановлен"} />{project.disabledReason ? <p className="type-caption mt-2 max-w-xs text-danger-text">{project.disabledReason}</p> : null}</td>
                      <td className="px-5 py-4"><p className="type-caption text-text-2">{numberLabel(project.interactions, "действие", "действия", "действий")} · {numberLabel(project.draftsCreated, "черновик", "черновика", "черновиков")} · {fmtNum(project.publicationsScheduled)} в очереди</p><p className="type-caption mt-1 text-text-3">{project.lastActivityAt ? fmtAgo(project.lastActivityAt) : "Активности ещё не было"}</p></td>
                      <td className="px-5 py-4"><StatusPill state={project.businessEnabled ? "healthy" : project.businessConnected ? "warning" : "neutral"} label={project.businessEnabled ? "Помощник включён" : project.businessConnected ? "Подключён, но выключен" : "Не подключён"} /><p className="type-caption mt-2 text-text-3">Ожидают решения: {numberLabel(project.openClientInquiries, "вопрос", "вопроса", "вопросов")}</p></td>
                      <td className="px-5 py-4"><div className="flex flex-col items-start gap-2">
                        {project.enabled ? <Button variant="danger" size="sm" onClick={() => setConfirmTarget({ type: "project", id: project.id, name: project.name })}>Приостановить в боте</Button> : <Button variant="secondary" size="sm" loading={actionKey === `enable-project-${project.id}`} onClick={() => void performAction({ action: "set_access", targetType: "project", targetId: project.id, enabled: true }, `enable-project-${project.id}`, `Проект «${project.name}» снова доступен в боте.`)}>Включить проект</Button>}
                        <Button variant="ghost" size="sm" disabled={!project.businessConnected || !project.enabled} loading={actionKey === `business-${project.id}`} onClick={() => void performAction({ action: "set_business", projectId: project.id, enabled: !project.businessEnabled }, `business-${project.id}`, project.businessEnabled ? `Клиентский помощник проекта «${project.name}» выключен.` : `Клиентский помощник проекта «${project.name}» включён с обязательным подтверждением.`)}>{project.businessEnabled ? "Выключить помощника" : "Включить помощника"}</Button>
                      </div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="divide-y divide-line lg:hidden">
              {data.projects.map((project) => (
                <li key={project.id} className="p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3"><div><h4 className="text-text">{project.name}</h4><p className="type-caption mt-1 text-text-3">{numberLabel(project.linkedMembers, "участник", "участника", "участников")} · {numberLabel(project.telegramChannels, "канал", "канала", "каналов")}</p></div><StatusPill state={project.enabled ? "healthy" : "danger"} label={project.enabled ? "Доступен" : "Приостановлен"} /></div>
                  <div className="mt-4 rounded-sm bg-surface-inset p-4"><StatusPill state={project.businessEnabled ? "healthy" : project.businessConnected ? "warning" : "neutral"} label={project.businessEnabled ? "Business включён" : project.businessConnected ? "Business выключен" : "Business не подключён"} /><p className="type-caption mt-2 text-text-3">{numberLabel(project.interactions, "действие", "действия", "действий")} · {numberLabel(project.draftsCreated, "черновик", "черновика", "черновиков")} · {fmtNum(project.publicationsScheduled)} в очереди · {numberLabel(project.openClientInquiries, "вопрос", "вопроса", "вопросов")}</p></div>
                  <div className="mt-4 flex flex-wrap gap-3">
                    {project.enabled ? <Button variant="danger" size="sm" onClick={() => setConfirmTarget({ type: "project", id: project.id, name: project.name })}>Приостановить в боте</Button> : <Button variant="secondary" size="sm" loading={actionKey === `enable-project-${project.id}`} onClick={() => void performAction({ action: "set_access", targetType: "project", targetId: project.id, enabled: true }, `enable-project-${project.id}`, `Проект «${project.name}» снова доступен в боте.`)}>Включить проект</Button>}
                    <Button variant="ghost" size="sm" disabled={!project.businessConnected || !project.enabled} loading={actionKey === `business-${project.id}`} onClick={() => void performAction({ action: "set_business", projectId: project.id, enabled: !project.businessEnabled }, `business-${project.id}`, project.businessEnabled ? `Клиентский помощник проекта «${project.name}» выключен.` : `Клиентский помощник проекта «${project.name}» включён с обязательным подтверждением.`)}>{project.businessEnabled ? "Выключить помощника" : "Включить помощника"}</Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section aria-labelledby="bot-interactions-title">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="type-label text-brand">Живая активность</p>
            <h3 id="bot-interactions-title" className="mt-2 text-text">Кто и как использует бот</h3>
            <p className="type-secondary mt-2 max-w-2xl text-pretty text-text-2">Последние команды, кнопки и типы сообщений без сохранения их содержимого.</p>
          </div>
          <span className="type-caption text-text-3">Последние {fmtNum(Math.min(data.interactions.length, 16))}</span>
        </div>
        {data.interactions.length === 0 ? (
          <div className="card-plain mt-5 rounded-md p-8 text-center">
            <Activity className="mx-auto h-8 w-8 text-text-3" aria-hidden />
            <h4 className="mt-3 text-text">Журнал взаимодействий пока пуст</h4>
            <p className="type-secondary mt-2 text-text-2">Новая команда или нажатие появятся здесь после следующего обновления данных.</p>
          </div>
        ) : (
          <ol className="mt-5 grid gap-3 xl:grid-cols-2">
            {data.interactions.slice(0, 16).map((interaction) => {
              const InteractionIcon = interaction.type === "command"
                ? Command
                : interaction.type === "callback" || interaction.type === "reply_button"
                  ? MousePointerClick
                  : MessageSquareText;
              return (
                <li key={interaction.id} className="card-plain flex min-w-0 gap-3 rounded-md p-4">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-sm bg-info-soft text-info-text">
                    <InteractionIcon className="h-5 w-5" strokeWidth={1.8} aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                      <p className="type-secondary min-w-0 font-semibold text-text">{interaction.user || "Непривязанный чат"}</p>
                      <time className="type-caption shrink-0 text-text-3" dateTime={interaction.createdAt}>{fmtAgo(interaction.createdAt)}</time>
                    </div>
                    <p className="type-caption mt-1 break-words text-text-2">{botActionLabel(interaction.type, interaction.action)}</p>
                    <p className="type-caption mt-1 truncate text-text-3">{INTERACTION_TYPE_LABEL[interaction.type] || "Действие"}{interaction.project ? ` · ${interaction.project}` : ""}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <div className="grid gap-5 xl:grid-cols-2">
        <section aria-labelledby="bot-deliveries-title">
          <h3 id="bot-deliveries-title" className="text-text">Последние доставки</h3>
          <p className="type-caption mt-1 text-text-3">Тексты сообщений и токены в журнал не записываются</p>
          <ol className="mt-5 overflow-hidden rounded-md border border-line bg-surface shadow-soft">
            {data.deliveries.length === 0 ? <li className="p-6 text-center text-text-2">Доставок после включения журнала ещё не было.</li> : data.deliveries.slice(0, 12).map((delivery) => (
              <li key={delivery.id} className="flex gap-3 border-b border-line p-4 last:border-b-0">
                <span className={cn("mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-sm", delivery.ok ? "bg-success-soft text-success-text" : "bg-danger-soft text-danger-text")}>
                  {delivery.ok ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <XCircle className="h-4 w-4" aria-hidden />}
                </span>
                <div className="min-w-0 flex-1"><p className="type-secondary font-semibold text-text">{delivery.ok ? "Доставлено" : "Не доставлено"} · {DELIVERY_SOURCE[delivery.source] || delivery.source}</p><p className="type-caption mt-1 break-words text-text-3">{delivery.user || delivery.project || "Системный адресат"} · {delivery.method}{delivery.errorCode ? ` · ${delivery.errorCode}` : ""}</p>{delivery.description ? <p className="type-caption mt-1 break-words text-danger-text">{delivery.description}</p> : null}</div>
                <time className="type-caption shrink-0 text-text-3" dateTime={delivery.createdAt}>{fmtAgo(delivery.createdAt)}</time>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="bot-audit-title">
          <h3 id="bot-audit-title" className="text-text">Журнал действий бота</h3>
          <p className="type-caption mt-1 text-text-3">Административные и редакционные события</p>
          <ol className="mt-5 overflow-hidden rounded-md border border-line bg-surface shadow-soft">
            {data.audit.length === 0 ? <li className="p-6 text-center text-text-2">Событий пока нет.</li> : data.audit.slice(0, 12).map((event) => (
              <li key={event.id} className="flex gap-3 border-b border-line p-4 last:border-b-0">
                <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-surface-inset text-text-2"><ShieldCheck className="h-4 w-4" aria-hidden /></span>
                <div className="min-w-0 flex-1"><p className="type-secondary font-semibold text-text">{ACTION_LABEL[event.action] || event.action}</p><p className="type-caption mt-1 truncate text-text-3">{event.target} · {event.actor}</p></div>
                <time className="type-caption shrink-0 text-text-3" dateTime={event.createdAt}>{fmtAgo(event.createdAt)}</time>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <div className="sr-only" role="status" aria-live="polite">{message}</div>
      {message ? <p className={cn("rounded-sm p-4", /не |сначала|ошиб|недоступ/iu.test(message) ? "bg-danger-soft text-danger-text" : "bg-success-soft text-success-text")}>{message}</p> : null}
      {loadError ? <p role="alert" className="rounded-sm bg-danger-soft p-4 text-danger-text">Не удалось обновить данные. На экране сохранён последний подтверждённый снимок.</p> : null}

      <ConfirmDialog
        open={Boolean(confirmTarget)}
        title={confirmTarget?.type === "user" ? "Приостановить доступ пользователя к боту?" : "Приостановить проект в боте?"}
        description={confirmTarget?.type === "user"
          ? `Бот перестанет выполнять действия для «${confirmTarget?.name || "пользователя"}» и закроет незавершённый диалог. Аккаунт, проекты и контент сохранятся.`
          : `Участники проекта «${confirmTarget?.name || "проект"}» временно не смогут управлять им через Telegram. Публикации, каналы и данные проекта сохранятся.`}
        confirmLabel={confirmTarget?.type === "user" ? "Приостановить доступ" : "Приостановить проект"}
        busy={Boolean(confirmTarget && actionKey === `disable-${confirmTarget.type}-${confirmTarget.id}`)}
        onCancel={() => setConfirmTarget(null)}
        onConfirm={() => {
          if (!confirmTarget) return;
          const target = confirmTarget;
          void performAction({ action: "set_access", targetType: target.type, targetId: target.id, enabled: false, reason: "Приостановлено администратором через центр управления ботом" }, `disable-${target.type}-${target.id}`, target.type === "user" ? `Доступ пользователя «${target.name}» к боту приостановлен.` : `Проект «${target.name}» приостановлен только в боте.`).then(() => setConfirmTarget(null));
        }}
      />
    </div>
  );
}
