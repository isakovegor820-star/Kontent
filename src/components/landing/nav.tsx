"use client";

// Навигация лендинга. Прозрачная над hero, при скролле — стеклянная панель.
// ТЗ 7.2: на экране один градиентный элемент-магнит — здесь это «Забрать ранний доступ».
// Всё остальное (пилюля активного раздела, плитки иконок, стекло) — спокойное, без градиентов.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { BookOpen, CircleHelp, Menu, Route, ShieldCheck, X } from "lucide-react";
import { Wordmark } from "@/components/brand";
import { Button, buttonClassName } from "@/components/ui/button";
import { Divider, GlassCard } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

const EASE = [0.22, 1, 0.36, 1] as const;

// После этой отметки нав перестаёт быть прозрачным и становится стеклом.
const SCROLL_THRESHOLD = 20;

// Высота панели (68px) + воздух. Якорь не должен уезжать под стекло.
const NAV_OFFSET = 80;

type NavIcon = React.ComponentType<{ className?: string; strokeWidth?: number }>;

type NavLink = {
  href: string;
  label: string;
  icon: NavIcon;
};

// Навигация ведёт по главным опорам текущего оффера: механика, память, качество и вопросы.
const LINKS: NavLink[] = [
  { href: "#how", label: "Как это работает", icon: Route },
  { href: "#memory", label: "Голос и факты", icon: BookOpen },
  { href: "#quality", label: "Контроль", icon: ShieldCheck },
  { href: "#faq", label: "Вопросы", icon: CircleHelp },
];

export function LandingNav() {
  const reduce = useReducedMotion();
  const menuId = useId();

  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);

  const headerRef = useRef<HTMLElement>(null);
  const burgerRef = useRef<HTMLButtonElement>(null);

  /* ------------------------------------------------------------- СКРОЛЛ */
  // Слушаем пассивно и через requestAnimationFrame: один пересчёт на кадр,
  // скролл остаётся гладким даже на слабом телефоне (ТЗ 8.2).
  useEffect(() => {
    let frame = 0;

    const read = () => {
      frame = 0;
      setScrolled(window.scrollY > SCROLL_THRESHOLD);
    };

    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(read);
    };

    read(); // перезагрузка на середине страницы — сразу верное состояние
    window.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  /* ------------------------------------------------- АКТИВНЫЙ РАЗДЕЛ */
  // Узкая полоса поперёк середины экрана: какой раздел её пересекает — тот и активен.
  // Если секции ещё нет в разметке, наблюдатель просто её не увидит — ничего не сломается.
  useEffect(() => {
    const targets = LINKS.map((l) => document.getElementById(l.href.slice(1))).filter(
      (el): el is HTMLElement => el !== null,
    );
    if (targets.length === 0) return;

    // Порядок именно документа, а не массива LINKS: секции на странице идут в другом порядке.
    const ordered = targets
      .slice()
      .sort((a, b) =>
        a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
      )
      .map((el) => el.id);

    const visible = new Set<string>();

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        // Берём последний по документу — тот, в который въезжаем.
        let current: string | null = null;
        for (const id of ordered) if (visible.has(id)) current = id;
        setActive(current ? `#${current}` : null);
      },
      { rootMargin: "-45% 0px -50% 0px" },
    );

    targets.forEach((t) => io.observe(t));
    return () => io.disconnect();
  }, []);

  /* --------------------------------------------- ЗАКРЫТИЕ МОБИЛЬНОГО МЕНЮ */
  // Escape и клик мимо. Фокус возвращаем на бургер — иначе он потеряется.
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      burgerRef.current?.focus();
    };

    const onPointerDown = (e: PointerEvent) => {
      if (headerRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  // Растянули окно до десктопа — меню больше не нужно, бургера там нет.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setOpen(false);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  /* ----------------------------------------------------------- ЯКОРЯ */
  // Прокручиваем сами: иначе заголовок раздела прячется под стеклянной панелью.
  const goToSection = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
      // Ctrl/Cmd-клик, средняя кнопка — пусть браузер откроет как хочет
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

      const target = document.getElementById(href.slice(1));
      if (!target) return; // раздела нет — не мешаем браузеру

      e.preventDefault();
      setOpen(false);

      const top = target.getBoundingClientRect().top + window.scrollY - NAV_OFFSET;
      window.scrollTo({ top: Math.max(0, top), behavior: reduce ? "auto" : "smooth" });
      window.history.replaceState(null, "", href);
    },
    [reduce],
  );

  const solid = scrolled || open;

  return (
    <header ref={headerRef} className="fixed top-0 right-0 left-0 z-50">
      {/* Стекло отдельным слоем: меняем только opacity — разметка не дёргается ни на пиксель.
          Слой чуть шире экрана, поэтому от рамки видна лишь нижняя грань. */}
      <div
        aria-hidden
        className={cn(
          "glass absolute -top-px -right-px -left-px bottom-0",
          "transition-opacity duration-300 ease-[var(--ease-soft)]",
          solid ? "opacity-100" : "opacity-0",
        )}
      />

      <div className="relative mx-auto max-w-6xl px-5 sm:px-8">
        <nav aria-label="Основная навигация" className="flex h-16 items-center sm:h-[68px]">
          {/* ------------------------------------------------- СЛЕВА: знак */}
          <Link
            href="/"
            aria-label="Аврора — наверх"
            className="-m-1 rounded-xs p-1 transition-opacity duration-200 hover:opacity-80"
          >
            <Wordmark />
          </Link>

          {/* ------------------------------- ПО ЦЕНТРУ: разделы (только lg+) */}
          <ul className="absolute inset-y-0 left-1/2 hidden -translate-x-1/2 items-center gap-1 lg:flex">
            {LINKS.map((l) => {
              const isActive = active === l.href;
              return (
                <li key={l.href}>
                  <a
                    href={l.href}
                    onClick={(e) => goToSection(e, l.href)}
                    aria-current={isActive ? "location" : undefined}
                    className={cn(
                      "relative flex h-11 cursor-pointer items-center rounded-full px-3.5",
                      "text-[14px] font-semibold whitespace-nowrap",
                      "transition-colors duration-200",
                      isActive ? "text-text" : "text-text-2 hover:text-text",
                    )}
                  >
                    {/* Пилюля переезжает между разделами — трансформом, без градиента */}
                    {isActive && (
                      <motion.span
                        layoutId="nav-pill"
                        aria-hidden
                        className="absolute inset-0 rounded-full bg-text/5"
                        transition={
                          reduce
                            ? { duration: 0 }
                            : { type: "spring", stiffness: 380, damping: 34, mass: 0.9 }
                        }
                      />
                    )}
                    <span className="relative">{l.label}</span>
                  </a>
                </li>
              );
            })}
          </ul>

          {/* ------------------------ СПРАВА: главное действие, бургер */}
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            {/* Единственный градиент в навигации (ТЗ 7.2).
                На узком экране он живёт в выпадающем меню — чтобы магнит на странице
                всегда оставался ровно один. */}
            <Link
              href="/register"
              className={buttonClassName({
                variant: "brand",
                size: "md",
                className: "hidden sm:inline-flex",
              })}
            >
              Забрать ранний доступ
            </Link>

            <Button
              ref={burgerRef}
              type="button"
              variant="ghost"
              size="icon"
              aria-expanded={open}
              aria-controls={menuId}
              aria-label={open ? "Закрыть меню" : "Открыть меню"}
              onClick={() => setOpen((v) => !v)}
              className="lg:hidden"
            >
              {/* Смена иконки — поворотом и прозрачностью, ничего не двигается */}
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={open ? "close" : "open"}
                  initial={{ rotate: open ? -90 : 90, opacity: 0 }}
                  animate={{ rotate: 0, opacity: 1 }}
                  exit={{ rotate: open ? 90 : -90, opacity: 0 }}
                  transition={{ duration: reduce ? 0 : 0.15, ease: EASE }}
                  className="flex"
                >
                  {open ? (
                    <X className="h-[22px] w-[22px]" strokeWidth={2} aria-hidden />
                  ) : (
                    <Menu className="h-[22px] w-[22px]" strokeWidth={2} aria-hidden />
                  )}
                </motion.span>
              </AnimatePresence>
            </Button>
          </div>
        </nav>

        {/* ------------------------------------------- МОБИЛЬНОЕ МЕНЮ */}
        {/* Высоту не анимируем принципиально: только opacity + сдвиг + масштаб от верхней грани */}
        <AnimatePresence>
          {open && (
            <motion.div
              key="menu"
              id={menuId}
              initial={{ opacity: 0, y: -10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.98 }}
              transition={{ duration: reduce ? 0 : 0.24, ease: EASE }}
              className="absolute inset-x-5 top-full origin-top sm:inset-x-8 lg:hidden"
            >
              <GlassCard strong className="mt-2 p-2.5">
                <ul>
                  {LINKS.map((l, i) => {
                    const isActive = active === l.href;
                    const Icon = l.icon;
                    return (
                      <motion.li
                        key={l.href}
                        initial={reduce ? false : { opacity: 0, y: -8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{
                          duration: reduce ? 0 : 0.28,
                          delay: reduce ? 0 : 0.03 + i * 0.045,
                          ease: EASE,
                        }}
                      >
                        <a
                          href={l.href}
                          onClick={(e) => goToSection(e, l.href)}
                          aria-current={isActive ? "location" : undefined}
                          className={cn(
                            "group flex h-12 cursor-pointer items-center gap-3 rounded-xs px-2.5",
                            "transition-colors duration-200 hover:bg-surface-inset/60",
                          )}
                        >
                          <span
                            className={cn(
                              "flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]",
                              "transition-colors duration-200",
                              isActive
                                ? "bg-info-soft text-info-text"
                                : "bg-surface-inset text-text-3 group-hover:text-text-2",
                            )}
                          >
                            <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
                          </span>
                          <span
                            className={cn(
                              "text-[15px] font-semibold transition-colors duration-200",
                              isActive ? "text-brand" : "text-text",
                            )}
                          >
                            {l.label}
                          </span>
                        </a>
                      </motion.li>
                    );
                  })}
                </ul>

                {/* Ниже sm кнопки в панели нет — значит магнит нужен здесь */}
                <div className="sm:hidden">
                  <Divider className="my-2.5" />
                  <Link
                    href="/register"
                    onClick={() => setOpen(false)}
                    className={buttonClassName({
                      variant: "brand",
                      size: "md",
                      className: "w-full",
                    })}
                  >
                    Забрать ранний доступ
                  </Link>
                </div>
              </GlassCard>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </header>
  );
}
