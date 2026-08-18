"use client";

/**
 * КАРКАС РАБОЧИХ ЭКРАНОВ ПЛАТФОРМЫ (Приложение А: экраны А4–А12).
 *
 * Визуальный мир — Aurora Glass с публичного лендинга: светлая основа,
 * фирменные синие акценты, прозрачные панели, мягкие тени и много воздуха.
 * Здесь остаётся только структура оболочки; цвета и физика приезжают из app-v3.css.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import {
  BarChart3,
  Bookmark,
  Calendar,
  ChevronDown,
  LogOut,
  Menu,
  SearchCode,
  Rocket,
  Scale,
  ScanSearch,
  Settings,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AuroraBackground } from "@/components/aurora-background";
import { Wordmark } from "@/components/brand";
import { ProjectSwitcher } from "@/components/app/project-switcher";
import { ProjectNotificationsInbox } from "@/components/app/project-notifications-inbox";
import { Button } from "@/components/ui/button";
import { H1, SecondaryText } from "@/components/ui/typography";
import { getAiUsageMetrics } from "@/lib/ai-usage-sync";
import {
  APP_BOTTOM_NAV_ROUTE_IDS,
  APP_NAV_GROUPS,
  APP_ROUTES,
  appRouteLabel,
  isAppRouteActive,
  type AppNavRouteId,
} from "@/lib/app-routes";
import {
  LEGAL_OPPORTUNITY_UNREAD_EVENT,
  safeLegalOpportunityUnreadCount,
} from "@/lib/legal-opportunity-unread";
import { useStore } from "@/lib/store";
import type { User } from "@/lib/types";
import { cn, fmtNum, plural } from "@/lib/utils";

/* ------------------------------------------------------------- НАВИГАЦИЯ */

type NavChild = {
  href: string;
  label: string;
  preserveParams?: readonly string[];
};

type NavItem = {
  routeId: AppNavRouteId;
  icon: LucideIcon;
  children?: readonly NavChild[];
};

const NAV_ICONS: Record<AppNavRouteId, LucideIcon> = {
  calendar: Calendar,
  studio: Sparkles,
  autopilot: Rocket,
  library: Bookmark,
  rss: Scale,
  recon: ScanSearch,
  siteAnalysis: SearchCode,
  analytics: BarChart3,
  settings: Settings,
};

const NAV_CHILDREN: Partial<Record<AppNavRouteId, readonly NavChild[]>> = {
  studio: [
    { href: "/app/studio?mode=chat", label: "Чат" },
    { href: "/app/studio/questions", label: "Запросы аудитории" },
    { href: "/app/studio?mode=media", label: "Картинки и видео" },
  ],
  autopilot: [
    { href: "/app/autopilot", label: "Недельный план" },
    { href: "/app/autopilot/month", label: "Кампания на месяц" },
  ],
  library: [
    { href: "/app/library?tab=hits", label: "Референсы", preserveParams: ["channel"] },
    { href: "/app/library?tab=posts", label: "Коллекция", preserveParams: ["channel"] },
  ],
  rss: [
    { href: "/app/rss", label: "Для вас", preserveParams: ["channel"] },
    { href: "/app/rss?view=saved", label: "Сохранённые", preserveParams: ["channel"] },
    { href: "/app/rss?view=used", label: "Использованные", preserveParams: ["channel"] },
    { href: "/app/rss?view=hidden", label: "Скрытые", preserveParams: ["channel"] },
  ],
  recon: [
    { href: "/app/recon", label: "Поиск" },
    { href: "/app/competitors", label: "Конкуренты" },
    { href: "/app/trends", label: "Тренды" },
  ],
  settings: [
    { href: "/app/settings?section=posts", label: "Настройки постов" },
    { href: "/app/settings?section=general", label: "Общие настройки" },
  ],
};

// Три группы — ровно порядок формулы продукта: работа → разведка → итоги.
// Состав, подписи, адреса и aliases общие с мобильной панелью и вложенными разделами.
const NAV_GROUPS: { title: string; items: NavItem[] }[] = APP_NAV_GROUPS.map((group) => ({
  title: group.title,
  items: group.routeIds.map((routeId) => ({
    routeId,
    icon: NAV_ICONS[routeId],
    children: NAV_CHILDREN[routeId],
  })),
}));

// Нижняя панель телефона — не больше пяти пунктов, иначе цели становятся тесными.
// Разведка — один пункт-хаб (как в сайдбаре): на всех её вкладках он остаётся активным.
const BOTTOM_NAV: NavItem[] = APP_BOTTOM_NAV_ROUTE_IDS.map((routeId) => ({
  routeId,
  icon: NAV_ICONS[routeId],
}));

function isActive(pathname: string, item: NavItem) {
  return isAppRouteActive(pathname, item.routeId);
}

function useLegalOpportunityUnreadCount(userId: number | null) {
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/rss/items?summary=unread", { cache: "no-store" });
      if (!response.ok) return;
      const body = await response.json() as { unreadCount?: unknown };
      setCount(safeLegalOpportunityUnreadCount(body.unreadCount));
    } catch {
      // Сбой фонового badge не должен перекрывать навигацию или старое корректное число.
    }
  }, []);

  useEffect(() => {
    if (userId == null) return;

    const startupTimer = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(() => void refresh(), 60_000);
    const handleUnread = (event: Event) => {
      const detail = (event as CustomEvent<{ count?: unknown }>).detail;
      setCount(safeLegalOpportunityUnreadCount(detail?.count));
    };
    const handleProjectChange = () => {
      setCount(0);
      void refresh();
    };
    window.addEventListener(LEGAL_OPPORTUNITY_UNREAD_EVENT, handleUnread);
    window.addEventListener("aurora:project-changed", handleProjectChange);
    return () => {
      window.clearTimeout(startupTimer);
      window.clearInterval(interval);
      window.removeEventListener(LEGAL_OPPORTUNITY_UNREAD_EVENT, handleUnread);
      window.removeEventListener("aurora:project-changed", handleProjectChange);
    };
  }, [refresh, userId]);

  return count;
}

function childHref(child: NavChild, searchParams: Pick<URLSearchParams, "get">): string {
  if (!child.preserveParams?.length) return child.href;

  const [pathname, query = ""] = child.href.split("?");
  const params = new URLSearchParams(query);
  child.preserveParams.forEach((key) => {
    const value = searchParams.get(key);
    if (value) params.set(key, value);
  });
  const suffix = params.toString();
  return suffix ? `${pathname}?${suffix}` : pathname;
}

/* --------------------------------------------------------------- БРЕНД */

function AppBrand() {
  return <Wordmark />;
}

/* ------------------------------------------------------- ЛИМИТ ИИ НА ДЕНЬ */
// Честность лимитов — требование ТЗ (раздел 6 и риск 12: стоимость ИИ).
// Цифры видны только после серверного подтверждения, а не выдумываются из начального нуля.

function AiLimitCard() {
  // Настоящий счётчик генераций за сегодня (Д.8), а не демо-число.
  const { aiUsed, aiLimit, aiUsageStatus } = useStore();
  const usage = getAiUsageMetrics(aiUsageStatus, aiUsed, aiLimit);

  if (!usage) {
    const loading = aiUsageStatus === "loading";
    return (
      <div
        role="status"
        aria-live="polite"
        className="rounded-sm border border-line bg-surface/80 p-3 shadow-soft backdrop-blur-xl"
      >
        <div className="flex items-center gap-2">
          <Sparkles
            className={cn("h-4 w-4 shrink-0", loading ? "text-brand" : "text-fire")}
            strokeWidth={2}
            aria-hidden
          />
          <p className="text-[13px] font-bold text-text">Лимит ИИ на сегодня</p>
        </div>
        <p className="mt-2 text-[13px] leading-snug text-text-2">
          {loading ? "Проверяем доступный лимит…" : "Счётчик временно недоступен."}
        </p>
        {!loading && (
          <p className="mt-0.5 text-[12px] leading-snug text-text-3">
            Не показываем остаток, пока сервер не подтвердит данные.
          </p>
        )}
      </div>
    );
  }

  const { used, limit, ratio, hot } = usage;

  return (
    <div
      className={cn(
        "rounded-sm border p-3 shadow-soft backdrop-blur-xl",
        hot ? "border-fire/25 bg-fire-soft" : "border-line bg-surface/80",
      )}
    >
      <div className="flex items-center gap-2">
        <Sparkles
          className={cn("h-4 w-4 shrink-0", hot ? "text-fire" : "text-brand")}
          strokeWidth={2}
          aria-hidden
        />
        <p className="text-[13px] font-bold text-text">Лимит ИИ на сегодня</p>
      </div>

      <div
        role="progressbar"
        aria-label="Использовано ИИ-генераций за сегодня"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={used}
        className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-inset"
      >
        {/* Только transform — ширину не анимируем никогда (ТЗ 7.4) */}
        <motion.div
          className={cn(
            "h-full w-full origin-left",
            hot ? "bg-fire" : "bg-brand-gradient",
          )}
          initial={{ scaleX: 0 }}
          animate={{ scaleX: ratio }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        />
      </div>

      <p className="nums mt-2 text-[12px] font-semibold text-text-2">
        {fmtNum(used)} из {fmtNum(limit)}{" "}
        {plural(limit, "генерации", "генераций", "генераций")}
      </p>
      <p className="mt-0.5 text-[13px] leading-snug text-text-3">
        {hot ? "Почти всё. Счётчик обнулится в полночь." : "Счётчик обнуляется в полночь."}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------ СТРОКА ЮЗЕРА */

function UserRow({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const initial = user.name.trim().charAt(0).toUpperCase() || "А";

  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-gradient text-[15px] font-bold text-white shadow-glow"
      >
        {initial}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-semibold text-text">{user.name}</p>
        <p className="truncate text-[13px] text-text-3">{user.email}</p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onSignOut}
        aria-label="Выйти из аккаунта"
        title="Выйти"
      >
        <LogOut className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
      </Button>
    </div>
  );
}

/* --------------------------------------------------------- НАЧИНКА САЙДБАРА */
// Один и тот же состав на десктопе и в выезжающей панели телефона.
// Активный пункт — жёлтый лист с рамкой и жёсткой тенью, без летящих индикаторов.

function SidebarInner({
  pathname,
  user,
  opportunityUnreadCount,
  onSignOut,
  onClose,
  closeRef,
}: {
  pathname: string;
  user: User;
  opportunityUnreadCount: number;
  onSignOut: () => void;
  onClose?: () => void;
  closeRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  const searchParams = useSearchParams();
  // Сворачиваемые группы навигации: по умолчанию все открыты,
  // группа с активным пунктом не сворачивается.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const activeItemRef = useRef<HTMLLIElement>(null);
  const toggleGroup = useCallback((title: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title); else next.add(title);
      return next;
    });
  }, []);

  useEffect(() => {
    const activeItem = activeItemRef.current;
    const navigation = activeItem?.closest("nav");
    if (!activeItem || !navigation) return;

    const revealChildren = () => {
      const itemRect = activeItem.getBoundingClientRect();
      const navigationRect = navigation.getBoundingClientRect();
      if (itemRect.bottom > navigationRect.bottom) {
        navigation.scrollTop += itemRect.bottom - navigationRect.bottom + 8;
      } else if (itemRect.top < navigationRect.top) {
        navigation.scrollTop -= navigationRect.top - itemRect.top + 8;
      }
    };

    const frame = requestAnimationFrame(revealChildren);
    const observer = new ResizeObserver(revealChildren);
    observer.observe(activeItem);
    observer.observe(navigation);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [pathname]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 shrink-0 items-center justify-between gap-2 px-4">
        <Link
          href="/app/calendar"
          onClick={onClose}
          aria-label="Аврора — на главный экран"
          className="transition-transform duration-150 hover:-translate-y-0.5"
        >
          <AppBrand />
        </Link>
        {onClose && (
          <Button
            ref={closeRef}
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Закрыть меню"
          >
            <X className="h-5 w-5" strokeWidth={1.75} aria-hidden />
          </Button>
        )}
      </div>

      <ProjectSwitcher />

      <nav
        aria-label="Разделы платформы"
        className="flex-1 space-y-4 overflow-y-auto px-3 pt-2 pb-4"
      >
        {NAV_GROUPS.map((group) => {
          const hasActive = group.items.some((item) => isActive(pathname, item));
          const isCollapsed = collapsedGroups.has(group.title) && !hasActive;
          return (
          <div key={group.title}>
            <button
              type="button"
              onClick={() => toggleGroup(group.title)}
              aria-expanded={!isCollapsed}
              className="flex w-full items-center justify-between px-3 pb-1.5 text-[12px] font-bold tracking-[0.08em] text-text-3 uppercase transition-colors hover:text-text"
            >
              {group.title}
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 transition-transform duration-200",
                  isCollapsed && "-rotate-90",
                )}
                aria-hidden
              />
            </button>
            {!isCollapsed && (
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const active = isActive(pathname, item);
                const Icon = item.icon;
                const route = APP_ROUTES[item.routeId];
                return (
                  <li
                    key={item.routeId}
                    ref={active && item.children ? activeItemRef : undefined}
                  >
                    <Link
                      href={route.href}
                      onClick={onClose}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "group relative flex min-h-11 items-center gap-3 rounded-xs py-2.5 pr-3 pl-3.5",
                        "text-[15px] font-semibold transition-colors duration-200",
                        active
                          ? "bg-info-soft text-brand"
                          : "text-text-2 hover:bg-surface-inset hover:text-text",
                      )}
                    >
                      {active && (
                        <span
                          aria-hidden
                          className="absolute top-3 bottom-3 left-0 w-[3px] rounded-full bg-brand-gradient"
                        />
                      )}
                      <Icon
                        className={cn(
                          "h-[18px] w-[18px] shrink-0 transition-colors duration-150",
                          active ? "text-brand" : "text-text-3 group-hover:text-text-2",
                        )}
                        strokeWidth={active ? 2 : 1.75}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1 leading-tight">{route.label}</span>
                      {item.routeId === "rss" && opportunityUnreadCount > 0 ? (
                        <>
                          <span
                            aria-hidden
                            className="nums min-w-6 shrink-0 rounded-full bg-brand px-1.5 py-1 text-center text-[11px] font-bold leading-none text-white shadow-soft"
                          >
                            {opportunityUnreadCount > 99 ? "99+" : opportunityUnreadCount}
                          </span>
                          <span className="sr-only">
                            {`, ${opportunityUnreadCount} ${plural(opportunityUnreadCount, "новый материал", "новых материала", "новых материалов")}`}
                          </span>
                        </>
                      ) : null}
                    </Link>
                    {active && item.children && (
                      <ul className="mt-1 ml-6 space-y-0.5 border-l border-brand/15 pl-3">
                        {item.children.map((child) => {
                          const [childPath, childQuery = ""] = child.href.split("?");
                          const childParams = new URLSearchParams(childQuery);
                          const siblingKeys = new Set(item.children?.flatMap((entry) => {
                            const [, query = ""] = entry.href.split("?");
                            return Array.from(new URLSearchParams(query).keys());
                          }) ?? []);
                          const childActive = pathname === childPath && (
                            childParams.size > 0
                              ? Array.from(childParams.entries()).every(([key, value]) => searchParams.get(key) === value)
                              : Array.from(siblingKeys).every((key) => !searchParams.has(key))
                          );
                          return (
                          <li key={child.href}>
                            <Link
                              href={childHref(child, searchParams)}
                              onClick={onClose}
                              aria-current={childActive ? "page" : undefined}
                              className={cn(
                                "flex min-h-9 items-center rounded-xs px-3 text-[13px] font-semibold transition-colors",
                                childActive
                                  ? "bg-surface-inset text-brand"
                                  : "text-text-3 hover:bg-surface-inset hover:text-brand",
                              )}
                            >
                              {child.label}
                            </Link>
                          </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
            )}
          </div>
          );
        })}
      </nav>

      <div className="shrink-0 space-y-3 border-t border-line p-3">
        <AiLimitCard />
        <UserRow user={user} onSignOut={onSignOut} />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- СКЕЛЕТОН */
// Пока состояние не поднялось из localStorage (s.ready === false) — рисуем
// тот же каркас серыми блоками. Не пустой экран и не редирект (ТЗ 7.4, уровень 1).
// Заголовок страницы известен сразу, поэтому показываем его настоящим —
// когда данные придут, ничего не дёрнется.

function ShellSkeleton({
  title,
  subtitle,
  stickyHeaderOnMobile = true,
}: {
  title: string;
  subtitle?: string;
  stickyHeaderOnMobile?: boolean;
}) {
  return (
    <div className="relative isolate min-h-dvh bg-bg" role="status" aria-busy="true">
      <span className="sr-only">Открываем платформу</span>

      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <AuroraBackground intensity="app" grid={false} grain={false} />
      </div>

      <div className="fixed inset-y-0 left-0 z-30 hidden w-[260px] flex-col border-r border-line bg-surface/80 backdrop-blur-xl lg:flex">
        <div className="flex h-16 shrink-0 items-center gap-2.5 px-4">
          <div className="skeleton h-8 w-8 rounded-xs" />
          <div className="skeleton h-4 w-24" />
        </div>
        <div className="flex-1 space-y-6 px-3 pt-2">
          {NAV_GROUPS.map((group) => (
            <div key={group.title} className="space-y-1">
              <div className="skeleton mx-3 mb-2 h-3 w-16" />
              {group.items.map((item) => (
                <div key={item.routeId} className="skeleton h-11 w-full rounded-xs" />
              ))}
            </div>
          ))}
        </div>
        <div className="shrink-0 space-y-3 border-t border-line p-3">
          <div className="skeleton h-[104px] w-full rounded-sm" />
          <div className="skeleton h-11 w-full rounded-xs" />
        </div>
      </div>

      <div className="lg:pl-[260px]">
        <div className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-surface/80 px-3 backdrop-blur-xl lg:hidden">
          <div className="skeleton h-9 w-9 rounded-xs" />
          <div className="skeleton h-5 w-28" />
          <div className="skeleton h-9 w-9 rounded-xs" />
        </div>

        <header className={cn(
          "z-20 border-b border-line bg-surface/70 backdrop-blur-xl lg:sticky lg:top-0",
          stickyHeaderOnMobile ? "sticky top-14" : "relative",
        )}>
          <div className="mx-auto flex max-w-[1400px] flex-wrap items-end justify-between gap-x-6 gap-y-3 px-4 py-4 sm:px-6 sm:py-5 lg:px-8">
            <div className="min-w-0">
              <H1>
                {title}
              </H1>
              {subtitle && (
                <SecondaryText className="mt-1.5 max-w-2xl text-pretty">
                  {subtitle}
                </SecondaryText>
              )}
            </div>
            <div className="w-full min-w-0 sm:w-auto sm:shrink-0">
              <div className="skeleton h-11 w-full rounded-xs sm:w-40" />
            </div>
          </div>
        </header>

        <main id="main" className="mx-auto max-w-[1400px] px-4 pt-6 pb-[var(--app-content-bottom-inset)] sm:px-6 lg:px-8 lg:pb-10">
          <div className="skeleton mb-4 h-11 w-64 rounded-sm" />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="skeleton h-44 rounded-md" />
            ))}
          </div>
        </main>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-2xl backdrop-saturate-150 lg:hidden">
        <div className="mx-auto flex h-14 max-w-lg items-center justify-around px-2">
          {BOTTOM_NAV.map((item) => (
            <div key={item.routeId} className="skeleton h-9 w-12 rounded-xs" />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ КАРКАС */

export function AppShell({
  children,
  title,
  subtitle,
  action,
  stickyHeaderOnMobile = true,
}: {
  children: React.ReactNode;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  stickyHeaderOnMobile?: boolean;
}) {
  const { ready, authReady, authError, user, signOut, refreshAuth } = useStore();
  const router = useRouter();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const opportunityUnreadCount = useLegalOpportunityUnreadCount(
    ready && authReady && user ? user.id : null,
  );

  const burgerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  // Выход уводит на лендинг — защита не должна перехватить и увести на /login
  const leavingRef = useRef(false);

  /* ЗАЩИТА: без входа — на страницу входа, без мастера — в мастер.
     Ждём ответа сервера о сессии (authReady), иначе выкинем вошедшего по ошибке. */
  useEffect(() => {
    if (!ready || !authReady || authError || leavingRef.current) return;
    if (!user) {
      router.replace("/login");
      return;
    }
    if (!user.onboarded && pathname !== "/app/onboarding") {
      router.replace("/app/onboarding");
    }
  }, [ready, authReady, authError, user, pathname, router]);

  /* На широком экране меню не существует — гасим, если экран вырос */
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 1024px)");
    const sync = () => {
      if (wide.matches) setMenuOpen(false);
    };
    wide.addEventListener("change", sync);
    return () => wide.removeEventListener("change", sync);
  }, []);

  /* Открытое меню: Escape, кнопка «назад», замок скролла, фокус внутрь и обратно.
     Переход по пункту меню закрывает панель сам — прямо в обработчике ссылки. */
  useEffect(() => {
    if (!menuOpen) return;
    const burger = burgerRef.current;
    closeRef.current?.focus();

    const close = () => setMenuOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = Array.from(
        drawerRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => !element.hasAttribute("hidden") && element.getClientRects().length > 0);
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !drawerRef.current?.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !drawerRef.current?.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    window.addEventListener("popstate", close);

    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("popstate", close);
      document.body.style.overflow = prevOverflow;
      burger?.focus();
    };
  }, [menuOpen]);

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  const handleSignOut = useCallback(() => {
    leavingRef.current = true;
    signOut();
    router.push("/");
  }, [signOut, router]);

  // Ошибка проверки сессии не равна «гость»: не выкидываем человека на регистрацию
  // и не показываем бесконечный скелетон, а даём явный повтор запроса.
  if (ready && authReady && authError && !user) {
    return (
      <main className="grid min-h-dvh place-items-center bg-bg px-5 py-10">
        <div
          role="alert"
          className="w-full max-w-lg rounded-md border border-line bg-surface/90 p-6 shadow-card backdrop-blur-xl"
        >
          <TriangleAlert className="h-7 w-7 text-fire" aria-hidden />
          <H1 className="mt-4">Не удалось проверить вход</H1>
          <SecondaryText className="mt-3 text-pretty">
            Сервер сессий временно недоступен. Мы не считаем тебя вышедшим и ничего не
            удаляем — попробуй ещё раз.
          </SecondaryText>
          <Button className="mt-5" variant="brand" onClick={() => void refreshAuth()}>
            Повторить проверку
          </Button>
        </div>
      </main>
    );
  }

  // Данных ещё нет, сессия не проверена или пользователю здесь не место — каркас, а не пустота
  if (!ready || !authReady || !user || (!user.onboarded && pathname !== "/app/onboarding")) {
    return (
      <ShellSkeleton
        title={title}
        subtitle={subtitle}
        stickyHeaderOnMobile={stickyHeaderOnMobile}
      />
    );
  }

  return (
    // reducedMotion="user": системная настройка гасит движение, оставляя прозрачность (ТЗ 7.4)
    <MotionConfig reducedMotion="user">
      <div className="relative isolate min-h-dvh bg-bg">
        <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
          <AuroraBackground intensity="app" grid={false} grain={false} />
        </div>

        {/* САЙДБАР — десктоп */}
        <aside className="fixed inset-y-0 left-0 z-30 hidden w-[260px] flex-col border-r border-line bg-surface/80 backdrop-blur-xl lg:flex">
          <SidebarInner
            pathname={pathname}
            user={user}
            opportunityUnreadCount={opportunityUnreadCount}
            onSignOut={handleSignOut}
          />
        </aside>

        {/* САЙДБАР — телефон: затемнение + выезжающая панель */}
        <AnimatePresence>
          {menuOpen && (
            <motion.div
              key="scrim"
              aria-hidden
              onClick={closeMenu}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="fixed inset-0 z-40 bg-text/40 backdrop-blur-sm lg:hidden"
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {menuOpen && (
            <motion.aside
              ref={drawerRef}
              key="drawer"
              id="app-drawer"
              role="dialog"
              aria-modal="true"
              aria-label="Меню платформы"
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={{ type: "spring", stiffness: 380, damping: 40, mass: 0.9 }}
              className="fixed inset-y-0 left-0 z-50 flex w-[280px] flex-col border-r border-line bg-surface/95 shadow-float backdrop-blur-2xl lg:hidden"
            >
              <SidebarInner
                pathname={pathname}
                user={user}
                opportunityUnreadCount={opportunityUnreadCount}
                onSignOut={handleSignOut}
                onClose={closeMenu}
                closeRef={closeRef}
              />
            </motion.aside>
          )}
        </AnimatePresence>

        {/* ПРАВАЯ КОЛОНКА */}
        <div className="lg:pl-[260px]">
          {/* Верхняя панель — только телефон */}
          <div className="sticky top-0 z-30 grid h-14 grid-cols-[44px_1fr_44px] items-center border-b border-line bg-surface/80 px-2 backdrop-blur-xl lg:hidden">
            <Button
              ref={burgerRef}
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setMenuOpen(true)}
              aria-label="Открыть меню"
              aria-expanded={menuOpen}
              aria-controls="app-drawer"
            >
              <Menu className="h-5 w-5" strokeWidth={1.75} aria-hidden />
            </Button>
            <div className="min-w-0 px-2"><ProjectSwitcher compact /></div>
            <span aria-hidden className="justify-self-end" />
          </div>

          {/* ШАПКА КОНТЕНТА: заголовок, подзаголовок и главное действие страницы */}
          <header className={cn(
            "z-20 border-b border-line bg-surface/70 backdrop-blur-xl lg:sticky lg:top-0",
            stickyHeaderOnMobile ? "sticky top-14" : "relative",
          )}>
            <div className="mx-auto flex max-w-[1400px] flex-wrap items-end justify-between gap-x-6 gap-y-3 px-4 py-4 sm:px-6 sm:py-5 lg:px-8">
              <div className="min-w-0">
                <H1>
                  {title}
                </H1>
                {subtitle && (
                  <SecondaryText className="mt-1.5 max-w-2xl text-pretty">
                    {subtitle}
                  </SecondaryText>
                )}
              </div>
              <div className="flex w-full min-w-0 flex-wrap items-center justify-end gap-2 sm:w-auto sm:shrink-0 sm:flex-nowrap">
                {action ? <div className="min-w-0 flex-1 sm:flex-none">{action}</div> : null}
                <ProjectNotificationsInbox />
              </div>
            </div>
          </header>

          {/* КОНТЕНТ: страница въезжает снизу — понятно, что сменился экран, а не сайт */}
          <main id="main" className="mx-auto max-w-[1400px] px-4 pt-6 pb-[var(--app-content-bottom-inset)] sm:px-6 lg:px-8 lg:pb-10">
            <motion.div
              key={pathname}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            >
              {children}
            </motion.div>
          </main>
        </div>

        {/* НИЖНЯЯ НАВИГАЦИЯ — телефон, четыре пункта, безопасная зона снизу.
            Та же бумажная панель, что сайдбар и шапка, — система выглядит едино. */}
        <nav
          aria-label="Основные разделы"
          className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-2xl backdrop-saturate-150 lg:hidden"
        >
          <ul className="mx-auto flex max-w-lg items-stretch">
            {BOTTOM_NAV.map((item) => {
              const active = isActive(pathname, item);
              const Icon = item.icon;
              const route = APP_ROUTES[item.routeId];
              const mobileLabel = appRouteLabel(item.routeId, "mobile");
              return (
                <li key={item.routeId} className="min-w-0 flex-1">
                  <Link
                    href={route.href}
                    aria-label={mobileLabel !== route.label ? route.label : undefined}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "relative flex h-14 flex-col items-center justify-center gap-1 px-1",
                      "transition-colors duration-150",
                      active ? "text-text" : "text-text-2",
                    )}
                  >
                    <span
                      className={cn(
                        "flex items-center justify-center rounded-full px-2.5 py-1",
                        active && "bg-info-soft text-brand",
                      )}
                    >
                      <Icon
                        className="h-5 w-5 shrink-0"
                        strokeWidth={active ? 2 : 1.75}
                        aria-hidden
                      />
                    </span>
                    <span className="w-full truncate text-center text-[13px] leading-none font-semibold">
                      {mobileLabel}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </MotionConfig>
  );
}
