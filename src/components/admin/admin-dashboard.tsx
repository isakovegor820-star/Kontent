"use client";

import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BarChart3,
  Bot,
  BriefcaseBusiness,
  CheckCircle2,
  Clock3,
  FileClock,
  History,
  Radio,
  RefreshCw,
  Send,
  Server,
  ShieldCheck,
  Sparkles,
  Users,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type RefObject, type MouseEvent } from "react";

import { AdminAiSpendCenter, AdminConnectionsCenter } from "./admin-resource-centers";
import { SnapshotNote, useSnapshotAge } from "./admin-ui";
import { Wordmark } from "@/components/brand";
import { AdminBotCenter } from "@/components/admin/admin-bot-center";
import { AdminCommandPalette } from "@/components/admin/admin-command-palette";
import { AdminAuditCenter } from "@/components/admin/admin-audit-center";
import { AdminAuroraAnalyticsCenter } from "@/components/admin/admin-aurora-analytics";
import { AdminInbox } from "@/components/admin/admin-inbox";
import { AdminProjectsCenter } from "@/components/admin/admin-projects-center";
import { AdminPublicationsCenter } from "@/components/admin/admin-publications-center";
import { AdminSystemCenter } from "@/components/admin/admin-system-center";
import { AdminUsersCenter } from "@/components/admin/admin-users-center";
import { Button, buttonClassName } from "@/components/ui/button";
import type { AdminDashboardData, AdminPeriodDays } from "@/lib/admin-dashboard";
import { adminPublicationsHref, adminUsersHref } from "@/lib/admin-url-state";
import { cn, fmtNum, NETWORK_LABEL } from "@/lib/utils";

type LoadError = "unauthorized" | "access_denied" | "unavailable";

const NAVIGATION = [
  { id: "overview", href: "#overview", label: "Обзор", icon: Activity },
  { id: "publications", href: "#publications", label: "Публикации", icon: Send },
  { id: "users", href: "#users", label: "Пользователи", icon: Users },
  { id: "connections", href: "#connections", label: "Подключения", icon: Radio },
  { id: "ai-usage", href: "#ai-usage", label: "AI и расходы", icon: Sparkles },
  { id: "projects", href: "#projects", label: "Проекты", icon: BriefcaseBusiness },
  { id: "bot-control", href: "#bot-control", label: "Управление ботом", icon: Bot },
  { id: "system", href: "#system", label: "Система", icon: Server },
  { id: "aurora-analytics", href: "#aurora-analytics", label: "Аналитика Авроры", icon: BarChart3 },
  { id: "audit", href: "#audit", label: "Журнал действий", icon: History },
] as const;

type AdminSection = (typeof NAVIGATION)[number]["id"];

const SECTION_COPY: Record<AdminSection, { eyebrow: string; title: string; description: string }> = {
  overview: { eyebrow: "Платформа", title: "Обзор", description: "Проверьте состояние сервисов и разберите задачи, которые требуют внимания." },
  publications: { eyebrow: "Операции", title: "Центр публикаций", description: "Поиск по ID, тексту, проекту и автору; повтор, перенос и отмена с записью в журнал." },
  users: { eyebrow: "Аккаунты", title: "Пользователи", description: "Способы входа, активность, проекты, каналы, публикации, AI и действия администратора." },
  connections: { eyebrow: "Интеграции", title: "Подключения", description: "Найдите канал, проверьте причину потери доступа и откройте владельца." },
  "ai-usage": { eyebrow: "Использование", title: "AI и расходы", description: "Попытки, известный расход и неуточнённая стоимость по проектам и моделям." },
  projects: { eyebrow: "Рабочие пространства", title: "Проекты", description: "Владелец, команда, каналы, публикации, автопилот и бот каждого рабочего пространства." },
  "bot-control": { eyebrow: "Telegram", title: "Управление ботом", description: "Подключения к Telegram-боту, активность и управление доступом к боту." },
  system: { eyebrow: "Платформа", title: "Состояние системы", description: "Доступность сервисов, последние проверки и диагностика отклонений." },
  "aurora-analytics": { eyebrow: "Продукт и качество", title: "Аналитика Авроры", description: "Использование разделов, ошибки и результаты работы пользователей." },
  audit: { eyebrow: "Контроль", title: "Журнал действий", description: "Изменения внутри проектов с фильтрами и ссылками на сущности, без чувствительных полей." },
};

/** Sections that render data from `/api/admin/overview`; the rest load their own APIs. */
const OVERVIEW_SECTIONS: ReadonlySet<AdminSection> = new Set<AdminSection>(["overview"]);

function adminSectionFromHash(hash: string): AdminSection {
  const candidate = hash.replace(/^#/, "");
  return NAVIGATION.some(({ id }) => id === candidate) ? candidate as AdminSection : "overview";
}

function MetricCard({
  label,
  value,
  helper,
  icon: Icon,
  tone = "neutral",
  href,
}: {
  label: string;
  value: number;
  helper: string;
  icon: LucideIcon;
  tone?: "neutral" | "brand" | "danger";
  href?: string;
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-4">
        <p className="type-label text-text-2">{label}</p>
        <span className={cn(
          "hidden h-9 w-9 shrink-0 place-items-center rounded-sm sm:grid",
          tone === "danger" ? "bg-danger-soft text-danger-text" : tone === "brand" ? "bg-info-soft text-info-text" : "bg-surface-inset text-text-2",
        )}>
          <Icon className="h-5 w-5" strokeWidth={1.8} aria-hidden />
        </span>
      </div>
      <p className="nums mt-3 text-[clamp(1.5rem,4vw,2.25rem)] font-bold leading-none tracking-[-0.035em] text-text sm:mt-4">
        {fmtNum(value)}
      </p>
      <p className="type-caption mt-1.5 text-text-3">{helper}</p>
    </>
  );
  if (href) {
    return (
      <a href={href} className="card-plain block rounded-md p-3.5 transition-colors duration-150 hover:border-brand/50 sm:p-5">
        {body}
      </a>
    );
  }
  return <article className="card-plain rounded-md p-3.5 sm:p-5">{body}</article>;
}

function StatusMark({
  state,
  label: customLabel,
}: {
  state: "healthy" | "attention" | "down" | "unknown";
  label?: string;
}) {
  const Icon = state === "healthy" ? CheckCircle2 : state === "attention" ? AlertTriangle : state === "down" ? XCircle : Clock3;
  const label = customLabel || (state === "healthy" ? "Работает" : state === "attention" ? "Требует внимания" : state === "down" ? "Недоступно" : "Нет подтверждения");
  return (
    <span className={cn(
      "type-caption inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-semibold whitespace-nowrap",
      state === "healthy" ? "bg-success-soft text-success-text" : state === "down" ? "bg-danger-soft text-danger-text" : state === "attention" ? "bg-fire-soft text-fire-text" : "bg-surface-inset text-text-2",
    )}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {label}
    </span>
  );
}

function OverviewSkeleton() {
  return (
    <div aria-busy="true">
      <div className="skeleton h-8 w-56 rounded-sm" />
      <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => <div key={index} className="skeleton h-40 rounded-md" />)}
      </div>
      <p role="status" className="sr-only">Загружаем операционные данные Авроры…</p>
    </div>
  );
}

function OverviewUnavailable({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  return (
    <div className="rounded-md border border-danger/20 bg-danger-soft p-6 sm:p-8">
      <XCircle className="h-8 w-8 text-danger-text" aria-hidden />
      <h3 className="mt-3 text-text">Сводка недоступна</h3>
      <p className="type-secondary mt-2 max-w-xl text-pretty text-text-2">
        Не удалось загрузить сводку. Данные платформы не изменены. Повторите загрузку или откройте диагностику сервисов.
      </p>
      <div className="mt-5 flex flex-col gap-3 sm:flex-row">
        <a href="#system" className={buttonClassName({ variant: "primary" })}>Открыть «Систему»<ArrowUpRight className="h-4 w-4" aria-hidden /></a>
        <Button variant="secondary" loading={retrying} onClick={onRetry}><RefreshCw className="h-4 w-4" aria-hidden />Повторить попытку</Button>
      </div>
    </div>
  );
}

function AdminAccessError({ error }: { error: Exclude<LoadError, "unavailable"> }) {
  const unauthorized = error === "unauthorized";
  return (
    <main id="main" tabIndex={-1} className="grid min-h-dvh place-items-center p-5">
      <section className="card-plain w-full max-w-xl rounded-lg p-7 text-center sm:p-10">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-md bg-danger-soft text-danger-text">
          <ShieldCheck className="h-7 w-7" aria-hidden />
        </span>
        <h1 className="mt-5 text-text">{unauthorized ? "Сессия завершена" : "Нет доступа к управлению"}</h1>
        <p className="type-body mx-auto mt-3 max-w-md text-pretty text-text-2">
          {unauthorized
            ? "Войдите снова, чтобы продолжить работу. После входа откройте нужный раздел панели."
            : "У этого аккаунта нет прав администратора платформы. Войдите с другим аккаунтом или обратитесь к ответственному за доступ."}
        </p>
        <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
          {unauthorized ? (
            <Link prefetch={false} href="/admin/login" className={buttonClassName({ variant: "primary" })}>Войти как администратор</Link>
          ) : (
            <Link href="/app/calendar" className={buttonClassName({ variant: "secondary" })}>Вернуться в кабинет</Link>
          )}
        </div>
      </section>
    </main>
  );
}

function DailyBars({ data }: { data: AdminDashboardData["daily"] }) {
  const maximum = Math.max(1, ...data.flatMap((item) => [item.publications, item.published]));
  return (
    <div className="card-plain min-w-0 max-w-full rounded-md p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-text">Поток публикаций</h3>
          <p className="type-caption mt-1 text-text-3">Создано и успешно опубликовано по дням</p>
        </div>
        <div className="type-caption flex flex-wrap gap-3 text-text-2" aria-label="Легенда графика">
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-brand" />Создано</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-success" />Опубликовано</span>
        </div>
      </div>
      <div className="mt-6 overflow-x-auto pb-2" role="region" aria-label="График публикаций по дням" tabIndex={0}>
        <ul className={cn("flex h-48 items-end gap-2", data.length <= 7 ? "w-full min-w-0" : "min-w-max")} aria-label="Публикации по дням">
          {data.map((item, index) => {
            const createdHeight = Math.max(item.publications > 0 ? 8 : 2, (item.publications / maximum) * 144);
            const publishedHeight = Math.max(item.published > 0 ? 8 : 2, (item.published / maximum) * 144);
            const date = new Date(`${item.date}T12:00:00Z`).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
            const showLabel = data.length <= 7 || index % 5 === 0 || index === data.length - 1;
            return (
              <li
                key={item.date}
                className={cn("flex shrink-0 flex-col items-center justify-end gap-1", data.length <= 7 ? "min-w-0 flex-1" : "w-8")}
                aria-label={`${date}: создано ${item.publications}, опубликовано ${item.published}`}
                title={`${date}: создано ${item.publications}, опубликовано ${item.published}`}
              >
                <div className="flex h-36 items-end gap-0.5" aria-hidden>
                  <span className="w-3 rounded-t-sm bg-brand" style={{ height: createdHeight }} />
                  <span className="w-3 rounded-t-sm bg-success" style={{ height: publishedHeight }} />
                </div>
                <span className="type-caption min-h-10 text-center text-text-3" aria-hidden>{showLabel ? date : ""}</span>
              </li>
            );
          })}
        </ul>
      </div>
      <details className="mt-3"><summary className="type-caption">Точные значения по дням</summary><table className="mt-2 w-full text-left"><thead><tr><th scope="col" className="py-2">Дата</th><th scope="col" className="py-2 text-right">Создано</th><th scope="col" className="py-2 text-right">Вышло</th></tr></thead><tbody>{data.map(item => <tr key={item.date} className="border-t border-line"><td className="py-2"><time dateTime={item.date}>{new Date(`${item.date}T12:00:00Z`).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}</time></td><td className="nums py-2 text-right">{fmtNum(item.publications)}</td><td className="nums py-2 text-right">{fmtNum(item.published)}</td></tr>)}</tbody></table></details>
    </div>
  );
}

function SectionNavigation({
  activeSection,
  onSelect,
  className,
  itemClassName,
  navRef,
}: {
  activeSection: AdminSection;
  onSelect: (section: AdminSection) => void;
  className: string;
  itemClassName?: string;
  navRef?: RefObject<HTMLElement | null>;
}) {
  return (
    <nav ref={navRef} aria-label="Разделы админ-панели" className={className}>
      <ul className={cn("flex gap-2", itemClassName)}>
        {NAVIGATION.map(({ id, href, label, icon: Icon }) => (
          <li key={href}>
            <a
              href={href}
              aria-current={activeSection === id ? "page" : undefined}
              onClick={() => onSelect(id)}
              className={cn(
                "type-button flex min-h-11 items-center gap-3 rounded-sm px-3.5 whitespace-nowrap transition-[background-color,color,transform] duration-150 active:scale-[0.96] motion-reduce:transform-none motion-reduce:transition-none",
                activeSection === id
                  ? "bg-info-soft text-info-text shadow-soft"
                  : "text-text-2 hover:bg-surface-inset hover:text-text",
              )}
            >
              <Icon className="h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden />
              {label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function AdminDashboard() {
  const mobileNavigationRef = useRef<HTMLElement>(null);
  const [activeSection, setActiveSection] = useState<AdminSection>("overview");
  const [sectionSynced, setSectionSynced] = useState(false);
  const [period, setPeriod] = useState<AdminPeriodDays>(7);
  const [data, setData] = useState<AdminDashboardData | null>(null);
  const [error, setError] = useState<LoadError | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const stale = useSnapshotAge(data?.checkedAt);

  useEffect(() => {
    const onAccess = (event: Event) => setError((event as CustomEvent<number>).detail === 401 ? "unauthorized" : "access_denied");
    window.addEventListener("aurora:admin-access", onAccess);
    return () => window.removeEventListener("aurora:admin-access", onAccess);
  }, []);

  // Until the hash is read on the client the section is unknown; fetching overview for the
  // SSR default would hit the summary query even when the admin opened «Система».
  const needsOverview = sectionSynced && OVERVIEW_SECTIONS.has(activeSection);

  useEffect(() => {
    const syncSection = () => {
      if (!window.dispatchEvent(new Event("aurora:admin-before-navigate", { cancelable: true }))) return;
      if (window.location.hash === "#main") return;
      const nextSection = adminSectionFromHash(window.location.hash);
      const days = new URLSearchParams(window.location.search).get("days");
      queueMicrotask(() => { setActiveSection(nextSection); setPeriod(days === "30" ? 30 : 7); setSectionSynced(true); });
    };
    syncSection();
    window.addEventListener("hashchange", syncSection);
    window.addEventListener("popstate", syncSection);
    return () => {
      window.removeEventListener("hashchange", syncSection);
      window.removeEventListener("popstate", syncSection);
    };
  }, []);

  // The overview payload is fetched only for the sections that render it, so an outage
  // of the summary query never blocks «Система», «Бот» or «Аналитика».
  useEffect(() => {
    if (!needsOverview) return;
    const controller = new AbortController();
    void fetch(`/api/admin/overview?days=${period}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) throw new Error("unauthorized");
        if (response.status === 403) throw new Error("access_denied");
        if (!response.ok) throw new Error("unavailable");
        return response.json() as Promise<AdminDashboardData>;
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setData(payload);
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
  }, [period, refreshKey, needsOverview]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const main = document.getElementById("main");
      main?.scrollIntoView({ block: "start" });
      if (!(activeSection === "users" && new URLSearchParams(window.location.search).has("user"))) main?.focus({ preventScroll: true });
      const navigation = mobileNavigationRef.current;
      const activeLink = navigation?.querySelector<HTMLElement>(`a[href="#${activeSection}"]`);
      if (navigation && activeLink) {
        navigation.scrollTo({
          left: Math.max(0, activeLink.offsetLeft - (navigation.clientWidth - activeLink.offsetWidth) / 2),
          behavior: "auto",
        });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeSection]);

  const pulse = data ? (() => {
    const dependencies = [data.system.database, data.system.redis, data.system.publicationWorker];
    if (stale || error === "unavailable" || data.periodDays !== period) return { state: "unknown" as const, title: "Состояние требует новой проверки", description: "Показан предыдущий снимок. Обновите данные перед административным действием." };
    if (dependencies.includes("down")) return { state: "down" as const, title: "Есть сбой в инфраструктуре", description: "Откройте диагностику сервисов перед повтором публикаций." };
    if (data.summary.failed + data.summary.quarantined + data.summary.overdue + data.summary.authAttention > 0 || data.system.ai === "attention") return { state: "attention" as const, title: "Есть задачи, требующие внимания", description: "Ниже — проблемы публикаций и подключений с переходом к разбору." };
    if (dependencies.some(state => state !== "up") || data.system.ai !== "healthy") return { state: "unknown" as const, title: "Не все сервисы подтвердили работу", description: "Отсутствие ошибок не подтверждает исправность. Проверьте подробности в разделе «Система»." };
    return { state: "healthy" as const, title: "Проверенные сервисы работают", description: "База, очередь, обработчик публикаций и AI подтвердили работу на момент снимка." };
  })() : null;

  if (error === "unauthorized" || error === "access_denied") return <AdminAccessError error={error} />;

  const requestRefresh = () => {
    if (needsOverview) setRefreshing(true);
    setError(null);
    setRefreshKey((value) => value + 1);
  };

  function navigateWithinAdmin(event: MouseEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as HTMLElement).closest("a[href]");
    if (!(link instanceof HTMLAnchorElement) || link.target || link.hasAttribute("download")) return;
    const url = new URL(link.href);
    if (url.origin !== window.location.origin || url.pathname !== "/admin" || !NAVIGATION.some(item => `#${item.id}` === url.hash)) return;
    event.preventDefault();
    if (url.href !== window.location.href) window.history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  const overviewLoading = (!sectionSynced || needsOverview) && !data && !error;
  const overviewFailed = needsOverview && !data && error === "unavailable";
  const showPeriodControls = ["overview", "users", "projects", "bot-control", "ai-usage"].includes(activeSection);
  const section = SECTION_COPY[activeSection];

  return (
    <div onClick={navigateWithinAdmin} className="mx-auto min-h-dvh w-full max-w-[1680px] lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className="border-b border-line bg-surface px-4 py-4 backdrop-blur-xl lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col lg:border-r lg:border-b-0 lg:p-4">
        <div className="flex items-center justify-between gap-4 lg:block">
          <div>
            <Wordmark />
            <p className="type-caption mt-1 text-text-3">Операционный центр</p>
          </div>
          <Link href="/app/calendar" className={buttonClassName({ variant: "ghost", size: "sm", className: "lg:hidden" })}>
            В кабинет
          </Link>
        </div>
        <div className="mt-5"><AdminCommandPalette /></div>
        <SectionNavigation activeSection={activeSection} onSelect={setActiveSection} className="mt-4 hidden lg:block" itemClassName="flex-col" />
        <div className="mt-auto hidden pt-8 lg:block">
          <div className="rounded-sm bg-info-soft p-4 text-info-text">
            <ShieldCheck className="h-5 w-5" aria-hidden />
            <p className="type-label mt-2">Администратор платформы</p>
            <p className="type-caption mt-1 text-pretty">Изменения фиксируются в журнале действий.</p>
          </div>
          <Link href="/app/calendar" className={buttonClassName({ variant: "secondary", className: "mt-3 w-full" })}>
            Открыть кабинет
            <ArrowUpRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      </aside>

      <main id="main" tabIndex={-1} className="min-w-0 px-4 py-6 sm:px-6 lg:px-7 lg:py-7">
        <span role="status" aria-live="polite" className="sr-only">
          Открыт раздел «{NAVIGATION.find(({ id }) => id === activeSection)?.label}».
        </span>
        <SectionNavigation
          navRef={mobileNavigationRef}
          activeSection={activeSection}
          onSelect={setActiveSection}
          className="sticky top-0 z-20 -mx-4 -mt-6 mb-6 overflow-x-auto border-y border-line bg-surface/95 px-4 py-2 backdrop-blur-xl sm:-mx-6 sm:px-6 lg:hidden"
          itemClassName="min-w-max"
        />
        <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="max-w-3xl">
            <p className="type-label text-brand">{section.eyebrow}</p>
            <h1 id={`${activeSection}-title`} className="mt-1.5 text-text">{section.title}</h1>
            <p className="type-caption mt-1.5 text-pretty text-text-3">{section.description}</p>
          </div>
          {activeSection !== "system" && activeSection !== "aurora-analytics" ? (
            <div className="flex flex-wrap items-center gap-2">
              {showPeriodControls ? <fieldset className="inline-flex rounded-sm border border-line bg-surface p-1" aria-label="Период данных">
                {([7, 30] as const).map((days) => (
                  <button
                    key={days}
                    type="button"
                    aria-pressed={period === days}
                    className={cn(
                      "type-button min-h-9 rounded-xs px-3 whitespace-nowrap transition-[background-color,color,transform] duration-150 active:scale-[0.96] motion-reduce:transform-none motion-reduce:transition-none",
                      period === days ? "bg-info-soft text-info-text" : "text-text-2 hover:bg-surface-inset hover:text-text",
                    )}
                    onClick={() => {
                      if (period === days) return;
                      if (needsOverview) setRefreshing(true);
                      setError(null);
                      setPeriod(days);
                      const url = new URL(window.location.href);
                      url.searchParams.set("days", String(days));
                      window.history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
                    }}
                  >
                    {days} дней
                  </button>
                ))}
              </fieldset> : null}
              <Button variant="secondary" size="sm" loading={refreshing} onClick={requestRefresh}>
                <RefreshCw className="h-4 w-4" aria-hidden />
                Обновить
              </Button>
            </div>
          ) : null}
        </header>

        {needsOverview && error === "unavailable" && data ? (
          <p role="alert" className="mt-4 rounded-sm bg-danger-soft p-4 text-danger-text">
            Не удалось обновить данные. Ниже сохранён предыдущий снимок. Повторите загрузку перед выполнением действия.
          </p>
        ) : null}

        {activeSection === "overview" ? (
          <section id="overview" className="scroll-mt-16 pt-6 pb-12" aria-labelledby="overview-title">
            {overviewLoading ? <OverviewSkeleton /> : null}
            {overviewFailed ? <OverviewUnavailable onRetry={requestRefresh} retrying={refreshing} /> : null}
            {data && pulse ? (
              <>
                <div className={cn(
                  "flex flex-col gap-3 rounded-lg border px-5 py-4 shadow-soft sm:flex-row sm:items-center sm:justify-between",
                  pulse.state === "healthy" ? "border-success/20 bg-success-soft" : pulse.state === "down" ? "border-danger/20 bg-danger-soft" : pulse.state === "attention" ? "border-fire/25 bg-fire-soft" : "border-line bg-surface",
                )}>
                  <div className="min-w-0 space-y-2">
                    <StatusMark state={pulse.state} />
                    <p className="type-body-strong text-text">{pulse.title}</p>
                    <p className="type-caption text-text-2">{pulse.description}</p>
                  </div>
                  <a href="#system" className={buttonClassName({ variant: "secondary", size: "sm", className: "shrink-0" })}>Проверить сервисы<ArrowUpRight className="h-4 w-4" aria-hidden /></a>
                </div>

                <div className="mt-4"><SnapshotNote checkedAt={data.checkedAt} period={`Сводка за ${data.periodDays} дней · «сегодня» по времени сервера`} failed={error === "unavailable"} busy={refreshing} onRefresh={requestRefresh} /></div>

                <div className="mt-5"><AdminInbox data={data} onChanged={requestRefresh} /></div>

                <h2 className="mt-7 text-text">Показатели платформы</h2>
                <div className="mt-4 grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
                  <MetricCard label="Пользователи" value={data.summary.usersTotal} helper={`${fmtNum(data.summary.newUsers)} новых за период`} icon={Users} href="#users" />
                  <MetricCard label="Аккаунты с сессией" value={data.summary.activeUsers} helper="Есть действующая сессия" icon={Activity} tone="brand" href={adminUsersHref("/admin", { status: "active" })} />
                  <MetricCard label="Проекты" value={data.summary.projectsTotal} helper="Неархивные пространства" icon={BriefcaseBusiness} href="#projects" />
                  <MetricCard label="Опубликовано сегодня" value={data.summary.publishedToday} helper={`${fmtNum(data.summary.scheduled)} запланировано`} icon={Send} tone="brand" href={adminPublicationsHref("/admin", { pstatus: "published" })} />
                  <MetricCard label="Ошибки за период" value={data.summary.failed} helper="Диагностика или повтор" icon={AlertTriangle} tone={data.summary.failed > 0 ? "danger" : "neutral"} href={adminPublicationsHref("/admin", { pstatus: "failed" })} />
                  <MetricCard label="Задержка очереди" value={data.summary.overdue} helper="Старше пяти минут" icon={FileClock} tone={data.summary.overdue > 0 ? "danger" : "neutral"} href={adminPublicationsHref("/admin", { pstatus: "overdue" })} />
                  <MetricCard label="Генерации AI сегодня" value={data.summary.aiToday} helper={`${fmtNum(data.summary.aiPeriod)} за период`} icon={Sparkles} href="#ai-usage" />
                  <MetricCard label="Проблемные каналы" value={data.summary.authAttention} helper="Каналы с ошибкой доступа" icon={Radio} tone={data.summary.authAttention > 0 ? "danger" : "neutral"} href="/admin?cnstatus=attention#connections" />
                </div>


                <div className="mt-4 grid min-w-0 max-w-full gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(20rem,0.8fr)]">
                  <DailyBars data={data.daily} />
                  <div className="card-plain min-w-0 max-w-full rounded-md p-5">
                    <h3 className="text-text">Подключённые соцсети</h3>
                    <p className="type-caption mt-1 text-text-3">Сохранённый статус подключения · не проверка API соцсети</p>
                    <ul className="mt-4 space-y-2">
                      {data.providers.length === 0 ? (
                        <li className="rounded-sm bg-surface-inset p-4 text-text-2">Подключений пока нет.</li>
                      ) : data.providers.map((provider) => (
                        <li key={provider.network} className="flex items-center justify-between gap-4 rounded-sm border border-line px-3 py-2.5">
                          <div className="min-w-0">
                            <p className="type-secondary font-semibold truncate text-text">{NETWORK_LABEL[provider.network] || provider.network}</p>
                            <p className="type-caption text-text-3">{fmtNum(provider.active)} из {fmtNum(provider.total)} подключены</p>
                          </div>
                          {provider.attention > 0 ? (
                            <a href={`/admin?cnq=${encodeURIComponent(provider.network)}&cnstatus=attention#connections`} aria-label={`Проверить проблемные подключения ${NETWORK_LABEL[provider.network] || provider.network}`}>
                              <StatusMark state="attention" label={`${fmtNum(provider.attention)} · внимание`} />
                            </a>
                          ) : <StatusMark state="unknown" label={provider.active > 0 ? "Подключены" : "Отключены"} />}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </>
            ) : null}
          </section>
        ) : null}

        {activeSection === "connections" ? <section id="connections" className="pt-6 pb-12" aria-labelledby="connections-title"><AdminConnectionsCenter refreshKey={refreshKey} /></section> : null}
        {activeSection === "ai-usage" ? <section id="ai-usage" className="pt-6 pb-12" aria-labelledby="ai-usage-title"><AdminAiSpendCenter period={period} refreshKey={refreshKey} /></section> : null}

        {activeSection === "publications" ? (
          <section id="publications" className="scroll-mt-16 pt-6 pb-12" aria-labelledby="publications-title">
            <AdminPublicationsCenter refreshKey={refreshKey} />
          </section>
        ) : null}

        {activeSection === "users" ? (
          <section id="users" className="scroll-mt-16 pt-6 pb-12" aria-labelledby="users-title">
            <AdminUsersCenter
              period={period}
              refreshKey={refreshKey}
              registrations={null}
            />
          </section>
        ) : null}

        {activeSection === "projects" ? (
          <section id="projects" className="scroll-mt-16 pt-6 pb-12" aria-labelledby="projects-title">
            <AdminProjectsCenter period={period} refreshKey={refreshKey} />
          </section>
        ) : null}

        {activeSection === "bot-control" ? (
          <section id="bot-control" className="scroll-mt-16 pt-6 pb-12" aria-labelledby="bot-control-title">
            <AdminBotCenter period={period} refreshKey={refreshKey} />
          </section>
        ) : null}

        {activeSection === "system" ? (
          <section id="system" className="scroll-mt-16 pt-2 pb-12" aria-labelledby="system-title">
            <AdminSystemCenter />
          </section>
        ) : null}

        {activeSection === "aurora-analytics" ? (
          <section id="aurora-analytics" className="scroll-mt-16 pt-2 pb-12" aria-labelledby="aurora-analytics-title">
            <AdminAuroraAnalyticsCenter />
          </section>
        ) : null}

        {activeSection === "audit" ? (
          <section id="audit" className="scroll-mt-16 pt-6 pb-12" aria-labelledby="audit-title">
            <AdminAuditCenter refreshKey={refreshKey} />
          </section>
        ) : null}
      </main>
    </div>
  );
}
