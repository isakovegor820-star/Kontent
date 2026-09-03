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
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { Wordmark } from "@/components/brand";
import { AdminBotCenter } from "@/components/admin/admin-bot-center";
import { AdminAuroraAnalyticsCenter } from "@/components/admin/admin-aurora-analytics";
import { AdminProjectsCenter } from "@/components/admin/admin-projects-center";
import { AdminPublicationsCenter } from "@/components/admin/admin-publications-center";
import { AdminSystemCenter } from "@/components/admin/admin-system-center";
import { AdminUsersCenter } from "@/components/admin/admin-users-center";
import { Button, buttonClassName } from "@/components/ui/button";
import type { AdminDashboardData, AdminPeriodDays } from "@/lib/admin-dashboard";
import { adminAuditActionLabel, adminAuditEntityLabel } from "@/lib/admin-labels";
import { adminPublicationsHref, adminUsersHref } from "@/lib/admin-url-state";
import { cn, fmtAgo, fmtNum, NETWORK_LABEL, plural } from "@/lib/utils";

type LoadError = "unauthorized" | "access_denied" | "unavailable";

const NAVIGATION = [
  { id: "overview", href: "#overview", label: "Обзор", icon: Activity },
  { id: "publications", href: "#publications", label: "Публикации", icon: Send },
  { id: "users", href: "#users", label: "Пользователи", icon: Users },
  { id: "projects", href: "#projects", label: "Проекты", icon: BriefcaseBusiness },
  { id: "bot-control", href: "#bot-control", label: "Управление ботом", icon: Bot },
  { id: "system", href: "#system", label: "Система", icon: Server },
  { id: "aurora-analytics", href: "#aurora-analytics", label: "Аналитика Авроры", icon: BarChart3 },
  { id: "audit", href: "#audit", label: "Журнал действий", icon: History },
] as const;

type AdminSection = (typeof NAVIGATION)[number]["id"];

/** Sections that render data from `/api/admin/overview`; the rest load their own APIs. */
const OVERVIEW_SECTIONS: ReadonlySet<AdminSection> = new Set<AdminSection>(["overview", "users", "audit"]);

function adminSectionFromHash(hash: string): AdminSection {
  const candidate = hash.replace(/^#/, "");
  return NAVIGATION.some(({ id }) => id === candidate) ? candidate as AdminSection : "overview";
}

function numberLabel(value: number, one: string, few: string, many: string) {
  return `${fmtNum(value)} ${plural(value, one, few, many)}`;
}

function SectionHeading({
  id,
  eyebrow,
  title,
  description,
}: {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="max-w-3xl">
      <p className="type-label text-brand">{eyebrow}</p>
      <h2 id={id} className="mt-2 text-text">{title}</h2>
      <p className="type-secondary mt-2 text-pretty text-text-2">{description}</p>
    </div>
  );
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
          "grid h-10 w-10 shrink-0 place-items-center rounded-sm",
          tone === "danger" ? "bg-danger-soft text-danger-text" : tone === "brand" ? "bg-info-soft text-info-text" : "bg-surface-inset text-text-2",
        )}>
          <Icon className="h-5 w-5" strokeWidth={1.8} aria-hidden />
        </span>
      </div>
      <p className="nums mt-5 text-[clamp(1.75rem,4vw,2.5rem)] font-bold leading-none tracking-[-0.035em] text-text">
        {fmtNum(value)}
      </p>
      <p className="type-caption mt-2 text-text-3">{helper}</p>
    </>
  );
  if (href) {
    return (
      <a href={href} className="card-plain block rounded-md p-5 transition-[border-color,transform] duration-150 hover:-translate-y-0.5 hover:border-brand/35 motion-reduce:transform-none">
        {body}
      </a>
    );
  }
  return <article className="card-plain rounded-md p-5">{body}</article>;
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
      state === "healthy" ? "bg-success-soft text-success-text" : state === "down" ? "bg-danger-soft text-danger-text" : "bg-fire-soft text-fire-text",
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
        Не удалось получить данные из базы. Раздел «Система» работает независимо — откройте его, чтобы увидеть, какая зависимость упала.
      </p>
      <div className="mt-5 flex flex-col gap-3 sm:flex-row">
        <a href="#system" className={buttonClassName({ variant: "primary" })}>Открыть «Систему»<ArrowUpRight className="h-4 w-4" aria-hidden /></a>
        <Button variant="secondary" loading={retrying} onClick={onRetry}><RefreshCw className="h-4 w-4" aria-hidden />Повторить</Button>
      </div>
    </div>
  );
}

function AdminAccessError({ error }: { error: Exclude<LoadError, "unavailable"> }) {
  const unauthorized = error === "unauthorized";
  return (
    <main id="main" className="grid min-h-dvh place-items-center p-5">
      <section className="card-plain w-full max-w-xl rounded-lg p-7 text-center sm:p-10">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-md bg-danger-soft text-danger-text">
          <ShieldCheck className="h-7 w-7" aria-hidden />
        </span>
        <h1 className="mt-5 text-text">{unauthorized ? "Войдите в Аврору" : "Нет доступа к управлению"}</h1>
        <p className="type-body mx-auto mt-3 max-w-md text-pretty text-text-2">
          {unauthorized
            ? "Админ-панель использует ту же защищённую сессию, что и основной кабинет."
            : "Доступ к данным всех проектов выдаётся только через серверный список администраторов."}
        </p>
        <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
          {unauthorized ? (
            <Link href="/admin/login" className={buttonClassName({ variant: "primary" })}>Войти как администратор</Link>
          ) : (
            <Link href="/app/calendar" className={buttonClassName({ variant: "secondary" })}>Вернуться в кабинет</Link>
          )}
        </div>
      </section>
    </main>
  );
}

function DailyBars({ data }: { data: AdminDashboardData["daily"] }) {
  const maximum = Math.max(1, ...data.map((item) => item.publications));
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
      <div className="mt-6 overflow-x-auto pb-2">
        <ul className="flex h-48 min-w-max items-end gap-2" aria-label="Публикации по дням">
          {data.map((item, index) => {
            const createdHeight = Math.max(item.publications > 0 ? 8 : 2, (item.publications / maximum) * 144);
            const publishedHeight = Math.max(item.published > 0 ? 8 : 2, (item.published / maximum) * 144);
            const date = new Date(`${item.date}T12:00:00Z`).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
            const showLabel = data.length <= 7 || index % 5 === 0 || index === data.length - 1;
            return (
              <li
                key={item.date}
                className={cn("flex shrink-0 flex-col items-center justify-end gap-1", data.length <= 7 ? "w-14" : "w-8")}
                aria-label={`${date}: создано ${item.publications}, опубликовано ${item.published}`}
                title={`${date}: создано ${item.publications}, опубликовано ${item.published}`}
              >
                <div className="flex h-36 items-end gap-0.5" aria-hidden>
                  <span className="w-3 rounded-t-sm bg-brand" style={{ height: createdHeight }} />
                  <span className="w-3 rounded-t-sm bg-success" style={{ height: publishedHeight }} />
                </div>
                <span className="type-caption h-4 whitespace-nowrap text-text-3" aria-hidden>{showLabel ? date : ""}</span>
              </li>
            );
          })}
        </ul>
      </div>
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

  // Until the hash is read on the client the section is unknown; fetching overview for the
  // SSR default would hit the summary query even when the admin opened «Система».
  const needsOverview = sectionSynced && OVERVIEW_SECTIONS.has(activeSection);

  useEffect(() => {
    const syncSection = () => {
      setActiveSection(adminSectionFromHash(window.location.hash));
      setSectionSynced(true);
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
      const desktopNavigation = window.matchMedia("(min-width: 64rem)").matches;
      document.getElementById(desktopNavigation ? "main" : activeSection)?.scrollIntoView({ block: "start" });
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

  const pulse = useMemo(() => {
    if (!data) return null;
    const workerDown = data.system.redis === "down" || data.system.publicationWorker === "down";
    const attention = data.summary.failed + data.summary.quarantined + data.summary.overdue + data.summary.authAttention;
    return {
      state: workerDown ? "down" as const : attention > 0 ? "attention" as const : "healthy" as const,
      attention,
      title: workerDown
        ? "Публикации могут быть остановлены"
        : attention > 0
          ? "Аврора работает, но есть задачи для команды"
          : "Система работает нормально",
      description: workerDown
        ? "Очередь или публикационный воркер не подтвердили готовность. Проверьте систему до повторных отправок."
        : attention > 0
          ? `${numberLabel(attention, "событие требует", "события требуют", "событий требуют")} внимания.`
          : "Очередь, подключения и последние публикации не показывают операционных проблем.",
    };
  }, [data]);

  if (error === "unauthorized" || error === "access_denied") return <AdminAccessError error={error} />;

  const requestRefresh = () => {
    if (needsOverview) setRefreshing(true);
    setError(null);
    setRefreshKey((value) => value + 1);
  };

  const overviewLoading = needsOverview && !data && !error;
  const overviewFailed = needsOverview && !data && error === "unavailable";
  const showPeriodControls = activeSection !== "system" && activeSection !== "aurora-analytics";

  return (
    <div className="mx-auto min-h-dvh w-full max-w-[1680px] lg:grid lg:grid-cols-[17rem_minmax(0,1fr)]">
      <aside className="border-b border-line bg-surface/85 px-4 py-4 backdrop-blur-xl lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col lg:border-r lg:border-b-0 lg:p-5">
        <div className="flex items-center justify-between gap-4 lg:block">
          <div>
            <Wordmark />
            <p className="type-caption mt-1 text-text-3">Операционный центр</p>
          </div>
          <Link href="/app/calendar" className={buttonClassName({ variant: "ghost", size: "sm", className: "lg:hidden" })}>
            В кабинет
          </Link>
        </div>
        <SectionNavigation activeSection={activeSection} onSelect={setActiveSection} className="mt-10 hidden lg:block" itemClassName="flex-col" />
        <div className="mt-auto hidden pt-8 lg:block">
          <div className="rounded-sm bg-info-soft p-4 text-info-text">
            <ShieldCheck className="h-5 w-5" aria-hidden />
            <p className="type-label mt-2">Защищённый режим</p>
            <p className="type-caption mt-1 text-pretty">Доступ отделён от ролей клиентских проектов.</p>
          </div>
          <Link href="/app/calendar" className={buttonClassName({ variant: "secondary", className: "mt-3 w-full" })}>
            Открыть кабинет
            <ArrowUpRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      </aside>

      <main id="main" className="min-w-0 px-4 py-6 sm:px-6 lg:px-10 lg:py-9">
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
        <header className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <p className="type-label text-brand">Пульс Авроры</p>
            <h1 className="mt-2 text-text">Управление платформой</h1>
            <p className="type-secondary mt-2 max-w-2xl text-pretty text-text-2">
              Состояние публикаций, подключений и активности клиентов — без демонстрационных данных.
            </p>
          </div>
          {showPeriodControls ? (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <fieldset>
                <legend className="type-caption mb-1.5 text-text-3">Период сравнения</legend>
                <div className="inline-flex rounded-sm border border-line bg-surface p-1">
                  {([7, 30] as const).map((days) => (
                    <button
                      key={days}
                      type="button"
                      aria-pressed={period === days}
                      className={cn(
                        "type-button min-h-11 rounded-xs px-3.5 whitespace-nowrap transition-[background-color,color,transform] duration-150 active:scale-[0.96] motion-reduce:transform-none motion-reduce:transition-none",
                        period === days ? "bg-brand text-white shadow-soft" : "text-text-2 hover:bg-surface-inset hover:text-text",
                      )}
                      onClick={() => {
                        if (period === days) return;
                        if (needsOverview) setRefreshing(true);
                        setError(null);
                        setPeriod(days);
                      }}
                    >
                      {days} дней
                    </button>
                  ))}
                </div>
              </fieldset>
              <Button variant="secondary" loading={refreshing} onClick={requestRefresh}>
                <RefreshCw className="h-4 w-4" aria-hidden />
                Обновить данные
              </Button>
            </div>
          ) : null}
        </header>

        {needsOverview && error === "unavailable" && data ? (
          <p role="alert" className="mt-5 rounded-sm bg-danger-soft p-4 text-danger-text">
            Не удалось обновить данные. Ниже сохранён последний подтверждённый снимок.
          </p>
        ) : null}

        {activeSection === "overview" ? (
          <section id="overview" className="scroll-mt-16 pt-8 pb-12" aria-labelledby="pulse-title">
            {overviewLoading ? <OverviewSkeleton /> : null}
            {overviewFailed ? <OverviewUnavailable onRetry={requestRefresh} retrying={refreshing} /> : null}
            {data && pulse ? (
              <>
                <div className={cn(
                  "relative overflow-hidden rounded-lg border p-6 shadow-soft sm:p-7",
                  pulse.state === "healthy" ? "border-success/20 bg-success-soft" : pulse.state === "down" ? "border-danger/20 bg-danger-soft" : "border-fire/25 bg-fire-soft",
                )}>
                  <div className="relative z-10 flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                    <div className="max-w-3xl">
                      <StatusMark state={pulse.state} />
                      <h2 id="pulse-title" className="mt-4 text-text">{pulse.title}</h2>
                      <p className="type-body mt-2 text-pretty text-text-2">{pulse.description}</p>
                    </div>
                    {pulse.attention > 0 && (
                      <a href="#publications" className={buttonClassName({ variant: pulse.state === "down" ? "danger" : "primary" })}>
                        Открыть задачи
                        <ArrowUpRight className="h-4 w-4" aria-hidden />
                      </a>
                    )}
                  </div>
                </div>

                <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <MetricCard label="Пользователи" value={data.summary.usersTotal} helper={`${fmtNum(data.summary.newUsers)} новых за период`} icon={Users} href="#users" />
                  <MetricCard label="Заходили за 30 дней" value={data.summary.activeUsers} helper="Аккаунты с неистёкшей сессией" icon={Activity} tone="brand" href={adminUsersHref("/admin", { status: "active" })} />
                  <MetricCard label="Команды и проекты" value={data.summary.projectsTotal} helper="Только неархивные пространства" icon={BriefcaseBusiness} href="#projects" />
                  <MetricCard label="Опубликовано сегодня" value={data.summary.publishedToday} helper={`${fmtNum(data.summary.scheduled)} сейчас запланировано`} icon={Send} tone="brand" />
                  <MetricCard label="Ошибки за период" value={data.summary.failed} helper="Требуют диагностики или повтора" icon={AlertTriangle} tone={data.summary.failed > 0 ? "danger" : "neutral"} href={adminPublicationsHref("/admin", { pstatus: "failed" })} />
                  <MetricCard label="Задержка очереди" value={data.summary.overdue} helper="Старше пяти минут" icon={FileClock} tone={data.summary.overdue > 0 ? "danger" : "neutral"} href={adminPublicationsHref("/admin", { pstatus: "overdue" })} />
                  <MetricCard label="AI сегодня" value={data.summary.aiToday} helper={`${fmtNum(data.summary.aiPeriod)} генераций за период`} icon={Sparkles} href="/admin?system=aurora_ai#system" />
                  <MetricCard label="Нужно переподключение" value={data.summary.authAttention} helper="Активные каналы с ошибкой доступа" icon={Radio} tone={data.summary.authAttention > 0 ? "danger" : "neutral"} href={adminUsersHref("/admin", { status: "attention" })} />
                </div>

                <div className="mt-5 grid min-w-0 max-w-full gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(20rem,0.8fr)]">
                  <DailyBars data={data.daily} />
                  <div className="card-plain min-w-0 max-w-full rounded-md p-5 sm:p-6">
                    <h3 className="text-text">Подключённые соцсети</h3>
                    <p className="type-caption mt-1 text-text-3">Состояние реальных подключений</p>
                    <ul className="mt-5 space-y-3">
                      {data.providers.length === 0 ? (
                        <li className="rounded-sm bg-surface-inset p-4 text-text-2">Подключений пока нет.</li>
                      ) : data.providers.map((provider) => (
                        <li key={provider.network} className="flex items-center justify-between gap-4 rounded-sm border border-line p-3.5">
                          <div className="min-w-0">
                            <p className="type-body-strong truncate text-text">{NETWORK_LABEL[provider.network] || provider.network}</p>
                            <p className="type-caption mt-0.5 text-text-3">{fmtNum(provider.active)} из {fmtNum(provider.total)} работают</p>
                          </div>
                          {provider.attention > 0 ? (
                            <a href={adminUsersHref("/admin", { status: "attention", network: provider.network })} aria-label={`Показать аккаунты с проблемными каналами ${NETWORK_LABEL[provider.network] || provider.network}`}>
                              <StatusMark state="attention" label={`${fmtNum(provider.attention)} · внимание`} />
                            </a>
                          ) : <StatusMark state="healthy" />}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </>
            ) : null}
          </section>
        ) : null}

        {activeSection === "publications" ? (
          <section id="publications" className="scroll-mt-16 pt-8 pb-12" aria-labelledby="publications-title">
            <SectionHeading
              id="publications-title"
              eyebrow="Операции"
              title="Центр публикаций"
              description="Поиск по ID, тексту, проекту и автору; фильтры по состоянию, сети и коду ошибки. Повтор, перенос и отмена выполняются с записью в журнал действий."
            />
            <div className="mt-6">
              <AdminPublicationsCenter refreshKey={refreshKey} />
            </div>
          </section>
        ) : null}

        {activeSection === "users" ? (
          <section id="users" className="scroll-mt-16 pt-8 pb-12" aria-labelledby="users-title">
            <SectionHeading
              id="users-title"
              eyebrow="Аккаунты"
              title="Пользователи и регистрации"
              description={`Полная операционная картина за ${period} дней: способы входа, активность, проекты, каналы, публикации, AI и состояние каждого аккаунта.`}
            />
            <div className="mt-6">
              <AdminUsersCenter
                period={period}
                refreshKey={refreshKey}
                registrations={data?.daily.map(({ date, registrations }) => ({ date, registrations })) ?? null}
              />
            </div>
          </section>
        ) : null}

        {activeSection === "projects" ? (
          <section id="projects" className="scroll-mt-16 pt-8 pb-12" aria-labelledby="projects-title">
            <SectionHeading
              id="projects-title"
              eyebrow="Тенанты"
              title="Проекты"
              description={`Все рабочие пространства за ${period} дней: владелец, команда, каналы, публикации, автопилот и бот. Карточка ведёт к участникам и публикациям проекта.`}
            />
            <div className="mt-6">
              <AdminProjectsCenter period={period} refreshKey={refreshKey} />
            </div>
          </section>
        ) : null}

        {activeSection === "bot-control" ? (
          <section id="bot-control" className="scroll-mt-16 pt-8 pb-12" aria-labelledby="bot-control-title">
            <SectionHeading
              id="bot-control-title"
              eyebrow="Telegram"
              title="Управление ботом"
              description="Состояние основного бота, подключённые аккаунты, активность, доставка, уведомления и Telegram Business — с обратимыми bot-only действиями администратора."
            />
            <div className="mt-6">
              <AdminBotCenter period={period} refreshKey={refreshKey} />
            </div>
          </section>
        ) : null}

        {activeSection === "system" ? (
          <section id="system" className="scroll-mt-16 pt-8 pb-12" aria-labelledby="system-title">
            <SectionHeading
              id="system-title"
              eyebrow="Платформа"
              title="Состояние системы"
              description="Проверки показывают только подтверждённое состояние зависимостей. Настроенный, но ещё не наблюдавшийся AI не помечается зелёным."
            />
            <AdminSystemCenter />
          </section>
        ) : null}

        {activeSection === "aurora-analytics" ? (
          <section id="aurora-analytics" className="scroll-mt-16 pt-8 pb-12" aria-labelledby="aurora-analytics-title">
            <SectionHeading
              id="aurora-analytics-title"
              eyebrow="Продукт и качество"
              title="Аналитика Авроры"
              description="Использование, техническое здоровье и подтверждённый полезный результат для всех пользовательских разделов из APP_ROUTES. Клиентские события не подменяют доменные факты."
            />
            <AdminAuroraAnalyticsCenter />
          </section>
        ) : null}

        {activeSection === "audit" ? (
          <section id="audit" className="scroll-mt-16 pt-8 pb-12" aria-labelledby="audit-title">
            <SectionHeading
              id="audit-title"
              eyebrow="Контроль"
              title="Последние действия"
              description="Журнал помогает восстановить последовательность изменений внутри проектов без показа чувствительных полей."
            />
            {overviewLoading ? <div className="mt-6"><OverviewSkeleton /></div> : null}
            {overviewFailed ? <div className="mt-6"><OverviewUnavailable onRetry={requestRefresh} retrying={refreshing} /></div> : null}
            {data ? (
              <ol className="mt-6 overflow-hidden rounded-md border border-line bg-surface shadow-soft">
                {data.audit.length === 0 ? (
                  <li className="p-6 text-text-2">Записей пока нет.</li>
                ) : data.audit.map((event) => (
                  <li key={event.id} className="flex gap-3 border-b border-line p-4 last:border-b-0 sm:items-center sm:px-5">
                    <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-surface-inset text-text-2 sm:mt-0">
                      <History className="h-4 w-4" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="type-secondary font-semibold text-text" title={event.action}>{adminAuditActionLabel(event.action)}</p>
                      <p className="type-caption mt-1 truncate text-text-3">
                        {event.project} · {event.actor} · {adminAuditEntityLabel(event.entityType)}{event.entityId ? ` ${event.entityId}` : ""}
                      </p>
                    </div>
                    <time className="type-caption shrink-0 text-text-3" dateTime={event.createdAt} title={new Date(event.createdAt).toLocaleString("ru-RU")}>{fmtAgo(event.createdAt)}</time>
                  </li>
                ))}
              </ol>
            ) : null}
          </section>
        ) : null}
      </main>
    </div>
  );
}
