"use client";

/**
 * КАРКАС РАБОЧИХ ЭКРАНОВ ПЛАТФОРМЫ (Приложение А: экраны А4–А12).
 *
 * ТЗ 7.1: «Рабочие экраны — спокойные, чистые, много воздуха».
 * Поэтому здесь аврора почти погашена (intensity="app", без сетки и зерна),
 * стекло — только у липких панелей, а градиент — только у трёх мелочей:
 * индикатор активного пункта, аватар и полоса лимита ИИ.
 * Главный «магнит» экрана (Button variant="brand") живёт в слоте `action`,
 * который передаёт страница — в каркасе градиентных кнопок нет (ТЗ 7.2).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import {
  BarChart3,
  Calendar,
  Flame,
  LogOut,
  Menu,
  Radar,
  Rocket,
  Settings,
  Sparkles,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AuroraBackground } from "@/components/aurora-background";
import { ThemeToggle, Wordmark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import type { User } from "@/lib/types";
import { cn, fmtNum, plural } from "@/lib/utils";

/* ------------------------------------------------------------- НАВИГАЦИЯ */

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Дочерние маршруты, на которых пункт остаётся подсвеченным */
  also?: string[];
};

// Три группы — ровно порядок формулы продукта: работа → разведка → итоги.
const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: "Работа",
    items: [
      // Редактор поста — часть календаря, поэтому пункт остаётся активным и там
      { href: "/app/calendar", label: "Календарь", icon: Calendar, also: ["/app/composer"] },
      { href: "/app/studio", label: "ИИ-студия", icon: Sparkles },
      { href: "/app/autopilot", label: "Автопилот", icon: Rocket },
    ],
  },
  {
    title: "Разведка",
    items: [
      { href: "/app/competitors", label: "Конкуренты", icon: Radar },
      { href: "/app/trends", label: "Тренды", icon: Flame },
    ],
  },
  {
    title: "Итоги",
    items: [
      { href: "/app/analytics", label: "Аналитика", icon: BarChart3 },
      { href: "/app/settings", label: "Настройки", icon: Settings },
    ],
  },
];

// Нижняя панель телефона — не больше пяти пунктов, иначе цели становятся тесными.
const BOTTOM_NAV: NavItem[] = [
  { href: "/app/calendar", label: "Календарь", icon: Calendar, also: ["/app/composer"] },
  { href: "/app/studio", label: "Студия", icon: Sparkles },
  { href: "/app/trends", label: "Тренды", icon: Flame },
  { href: "/app/competitors", label: "Конкуренты", icon: Radar },
  { href: "/app/analytics", label: "Аналитика", icon: BarChart3 },
];

// Пружина индикатора: живо, но укладывается в потолок 600 мс (ТЗ 7.4)
const SPRING = { type: "spring", stiffness: 420, damping: 36, mass: 0.7 } as const;

function isActive(pathname: string, item: NavItem) {
  return [item.href, ...(item.also ?? [])].some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

/* ------------------------------------------------------- ЛИМИТ ИИ НА ДЕНЬ */
// Честность лимитов — требование ТЗ (раздел 6 и риск 12: стоимость ИИ).
// Цифры видны всегда, а не всплывают в момент отказа.

function AiLimitCard() {
  // Настоящий счётчик генераций за сегодня (Д.8), а не демо-число.
  const { aiUsed: used, aiLimit: limit } = useStore();
  const ratio = limit > 0 ? Math.min(1, used / limit) : 1;
  const hot = ratio >= 0.9;

  return (
    <div
      className={cn(
        "rounded-sm border p-3",
        hot ? "border-fire/30 bg-fire-soft" : "border-line bg-surface-2",
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
            "h-full w-full origin-left rounded-full",
            hot ? "bg-fire" : "bg-brand-gradient",
          )}
          initial={{ scaleX: 0 }}
          animate={{ scaleX: ratio }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        />
      </div>

      <p className="nums mt-2 text-[13px] font-semibold text-text-2">
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
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-gradient text-[15px] font-bold text-white"
      >
        {initial}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-semibold text-text">{user.name}</p>
        <p className="truncate text-[13px] text-text-3">{user.email}</p>
      </div>
      <ThemeToggle />
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
// `scope` разводит layoutId: два одинаковых id в дереве заставили бы
// индикатор «летать» между невидимым десктопным сайдбаром и панелью.

function SidebarInner({
  scope,
  pathname,
  user,
  onSignOut,
  onClose,
  closeRef,
}: {
  scope: "desktop" | "mobile";
  pathname: string;
  user: User;
  onSignOut: () => void;
  onClose?: () => void;
  closeRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 shrink-0 items-center justify-between gap-2 px-4">
        <Link
          href="/app/calendar"
          onClick={onClose}
          aria-label="Аврора — на главный экран"
          className="rounded-xs transition-opacity duration-200 hover:opacity-80"
        >
          <Wordmark />
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

      <nav
        aria-label="Разделы платформы"
        className="flex-1 space-y-6 overflow-y-auto px-3 pt-2 pb-4"
      >
        {NAV_GROUPS.map((group) => (
          <div key={group.title}>
            <p className="px-3 pb-1.5 text-[13px] font-bold tracking-wider text-text-3 uppercase">
              {group.title}
            </p>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const active = isActive(pathname, item);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onClose}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "group relative flex h-11 items-center gap-3 rounded-xs pr-3 pl-3.5",
                        "text-[15px] font-semibold transition-colors duration-200 ease-[var(--ease-soft)]",
                        active
                          ? "bg-info-soft text-brand"
                          : "text-text-2 hover:bg-surface-inset hover:text-text",
                      )}
                    >
                      {active && (
                        // Полоска-индикатор плавно перелетает между пунктами
                        <motion.span
                          layoutId={`navIndicator-${scope}`}
                          aria-hidden
                          transition={SPRING}
                          className="absolute top-3 bottom-3 left-0 w-[3px] rounded-full bg-brand-gradient"
                        />
                      )}
                      <Icon
                        className={cn(
                          "h-[18px] w-[18px] shrink-0 transition-colors duration-200",
                          active ? "text-brand" : "text-text-3 group-hover:text-text-2",
                        )}
                        strokeWidth={active ? 2 : 1.75}
                        aria-hidden
                      />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
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

function ShellSkeleton({ title, subtitle }: { title: string; subtitle?: string }) {
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
                <div key={item.href} className="skeleton h-11 w-full rounded-xs" />
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

        <header className="sticky top-14 z-20 border-b border-line bg-surface/70 backdrop-blur-xl lg:top-0">
          <div className="mx-auto flex max-w-[1400px] flex-wrap items-end justify-between gap-x-6 gap-y-3 px-4 py-4 sm:px-6 sm:py-5 lg:px-8">
            <div className="min-w-0">
              <h1 className="text-2xl font-extrabold tracking-tight text-text sm:text-3xl">
                {title}
              </h1>
              {subtitle && (
                <p className="mt-1.5 max-w-2xl text-[15px] leading-relaxed text-text-2">
                  {subtitle}
                </p>
              )}
            </div>
            <div className="skeleton h-11 w-40 rounded-xs" />
          </div>
        </header>

        <main id="main" className="mx-auto max-w-[1400px] px-4 pt-6 pb-24 sm:px-6 lg:px-8 lg:pb-10">
          <div className="skeleton mb-4 h-11 w-64 rounded-sm" />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="skeleton h-44 rounded-md" />
            ))}
          </div>
        </main>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/85 backdrop-blur-2xl backdrop-saturate-150 pb-[env(safe-area-inset-bottom)] lg:hidden">
        <div className="mx-auto flex h-14 max-w-lg items-center justify-around px-2">
          {BOTTOM_NAV.map((item) => (
            <div key={item.href} className="skeleton h-9 w-12 rounded-xs" />
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
}: {
  children: React.ReactNode;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  const { ready, authReady, user, signOut } = useStore();
  const router = useRouter();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  const burgerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // Выход уводит на лендинг — защита не должна перехватить и увести на /register
  const leavingRef = useRef(false);

  /* ЗАЩИТА: без входа — на регистрацию, без мастера — в мастер.
     Ждём ответа сервера о сессии (authReady), иначе выкинем вошедшего по ошибке. */
  useEffect(() => {
    if (!ready || !authReady || leavingRef.current) return;
    if (!user) {
      router.replace("/register");
      return;
    }
    if (!user.onboarded && pathname !== "/app/onboarding") {
      router.replace("/app/onboarding");
    }
  }, [ready, authReady, user, pathname, router]);

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
      if (e.key === "Escape") close();
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

  // Данных ещё нет, сессия не проверена или пользователю здесь не место — каркас, а не пустота
  if (!ready || !authReady || !user || (!user.onboarded && pathname !== "/app/onboarding")) {
    return <ShellSkeleton title={title} subtitle={subtitle} />;
  }

  return (
    // reducedMotion="user": системная настройка гасит движение, оставляя прозрачность (ТЗ 7.4)
    <MotionConfig reducedMotion="user">
      <div className="relative isolate min-h-dvh bg-bg">
        {/* Фон живой, но почти неслышный — рабочий экран остаётся спокойным (ТЗ 7.1) */}
        <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
          <AuroraBackground intensity="app" grid={false} grain={false} />
        </div>

        {/* САЙДБАР — десктоп */}
        <aside className="fixed inset-y-0 left-0 z-30 hidden w-[260px] flex-col border-r border-line bg-surface/80 backdrop-blur-xl lg:flex">
          <SidebarInner
            scope="desktop"
            pathname={pathname}
            user={user}
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
              className="fixed inset-0 z-40 bg-text/40 backdrop-blur-sm lg:hidden dark:bg-bg/70"
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {menuOpen && (
            <motion.aside
              key="drawer"
              id="app-drawer"
              role="dialog"
              aria-modal="true"
              aria-label="Меню платформы"
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={{ type: "spring", stiffness: 380, damping: 40, mass: 0.9 }}
              className="fixed inset-y-0 left-0 z-50 flex w-[280px] flex-col border-r border-line bg-surface shadow-float lg:hidden"
            >
              <SidebarInner
                scope="mobile"
                pathname={pathname}
                user={user}
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
            <Link
              href="/app/calendar"
              aria-label="Аврора — на главный экран"
              className="justify-self-center rounded-xs"
            >
              <Wordmark />
            </Link>
            {/* key: переключатель темы читает тему при монтировании. Пересобираем его
                вместе с меню, чтобы иконка не разошлась с той, что нажали в панели. */}
            <ThemeToggle
              key={menuOpen ? "menu-open" : "menu-closed"}
              className="justify-self-end"
            />
          </div>

          {/* ШАПКА КОНТЕНТА: заголовок, подзаголовок и главное действие страницы */}
          <header className="sticky top-14 z-20 border-b border-line bg-surface/70 backdrop-blur-xl lg:top-0">
            <div className="mx-auto flex max-w-[1400px] flex-wrap items-end justify-between gap-x-6 gap-y-3 px-4 py-4 sm:px-6 sm:py-5 lg:px-8">
              <div className="min-w-0">
                <h1 className="text-2xl font-extrabold tracking-tight text-text sm:text-3xl">
                  {title}
                </h1>
                {subtitle && (
                  <p className="mt-1.5 max-w-2xl text-[15px] leading-relaxed text-text-2">
                    {subtitle}
                  </p>
                )}
              </div>
              {action && <div className="shrink-0">{action}</div>}
            </div>
          </header>

          {/* КОНТЕНТ: страница въезжает снизу — понятно, что сменился экран, а не сайт */}
          <main id="main" className="mx-auto max-w-[1400px] px-4 pt-6 pb-24 sm:px-6 lg:px-8 lg:pb-10">
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

        {/* НИЖНЯЯ НАВИГАЦИЯ — телефон, пять пунктов, безопасная зона снизу.
            Стекло собрано из токенов, а не утилитой glass-strong: та задаёт border
            сокращением на все четыре стороны и съела бы верхнюю границу-волосок.
            Тот же рецепт, что у сайдбара и шапки — панели выглядят одинаково. */}
        <nav
          aria-label="Основные разделы"
          className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/85 backdrop-blur-2xl backdrop-saturate-150 pb-[env(safe-area-inset-bottom)] lg:hidden"
        >
          <ul className="mx-auto flex max-w-lg items-stretch">
            {BOTTOM_NAV.map((item) => {
              const active = isActive(pathname, item);
              const Icon = item.icon;
              return (
                <li key={item.href} className="min-w-0 flex-1">
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "relative flex h-14 flex-col items-center justify-center gap-1 px-1",
                      "transition-colors duration-200",
                      active ? "text-brand" : "text-text-2",
                    )}
                  >
                    {active && (
                      <motion.span
                        layoutId="navIndicator-bottom"
                        aria-hidden
                        transition={SPRING}
                        className="absolute inset-x-3 top-0 h-[2px] rounded-full bg-brand-gradient"
                      />
                    )}
                    <Icon
                      className="h-5 w-5 shrink-0"
                      strokeWidth={active ? 2 : 1.75}
                      aria-hidden
                    />
                    <span className="w-full truncate text-center text-[13px] leading-none font-semibold">
                      {item.label}
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
