"use client";

import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useSearchParams } from "next/navigation";
import { ArrowRight, BookOpen, ChevronLeft, CircleHelp, Search, X, Minus, Plus, GripHorizontal, MoveDiagonal2, RotateCcw } from "lucide-react";
import { Button, buttonClassName } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import { useModalFocus } from "@/components/ui/use-modal-focus";
import { APP_ROUTES, type AppNavRouteId } from "@/lib/app-routes";
import { currentDiscoverySection, DISCOVERY_SECTIONS, guideHref, searchDiscovery, SECTION_HELP, type DiscoveryEntry } from "@/lib/aurora-discovery";
import { cn } from "@/lib/utils";
import { useGuideWindow } from "./use-guide-window";
import "./aurora-discovery.css";

type DiscoveryContextValue = {
  searchOpen: boolean;
  openSearch: () => void;
  guideSection: AppNavRouteId | null;
  explain: (section?: AppNavRouteId) => void;
};
const DiscoveryContext = createContext<DiscoveryContextValue | null>(null);

function Avatar() {
  return <Image src="/brand/aurora-bot-avatar.png" alt="" width={32} height={32} className="h-8 w-8 shrink-0 rounded-full object-cover outline outline-1 outline-[var(--image-outline)]" />;
}

/** The URL only opts into help; it never triggers generation, saving or publishing. */
export function AuroraDiscovery({ children, navigationOpen = false }: { children: React.ReactNode; navigationOpen?: boolean }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const current = currentDiscoverySection(pathname);
  const requested = params.get("guide");
  return <DiscoveryProvider navigationKey={`${pathname}:${requested ?? ""}`} current={current} initialGuide={requested === current ? current : undefined} navigationOpen={navigationOpen}>{children}</DiscoveryProvider>;
}

function DiscoveryProvider({ children, current, initialGuide, navigationOpen, navigationKey }: { children: React.ReactNode; current?: AppNavRouteId; initialGuide?: AppNavRouteId; navigationOpen: boolean; navigationKey: string }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [guideSection, setGuideSection] = useState<AppNavRouteId | null>(initialGuide ?? null);
  const [step, setStep] = useState<number | null>(initialGuide && SECTION_HELP[initialGuide].steps ? 0 : null);
  const [collapsed, setCollapsed] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const panelTitle = useRef<HTMLHeadingElement>(null);
  const focusGuide = useRef(Boolean(initialGuide));
  const previousNavigation = useRef(navigationKey);

  // Synchronize explicit guide links/back navigation without remounting the page's forms.
  useEffect(() => {
    if (previousNavigation.current === navigationKey) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      previousNavigation.current = navigationKey;
      focusGuide.current = Boolean(initialGuide);
      setSearchOpen(false);
      setGuideSection(initialGuide ?? null);
      setStep(initialGuide && SECTION_HELP[initialGuide].steps ? 0 : null);
      setCollapsed(false);
    });
    return () => { cancelled = true; };
  }, [navigationKey, initialGuide]);

  const explain = (section = current ?? "today") => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    focusGuide.current = true;
    setGuideSection(section); setStep(null); setCollapsed(false);
    requestAnimationFrame(() => panelTitle.current?.focus({ preventScroll: true }));
  };
  const closeGuide = () => {
    setGuideSection(null); setStep(null);
    const previous = returnFocus.current;
    requestAnimationFrame(() => (previous?.isConnected ? previous : document.getElementById("aurora-guide-trigger"))?.focus({ preventScroll: true }));
    const url = new URL(window.location.href);
    if (url.searchParams.has("guide")) {
      url.searchParams.delete("guide");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }
  };

  useEffect(() => {
    if (!guideSection || !focusGuide.current) return;
    const frame = requestAnimationFrame(() => { panelTitle.current?.focus({ preventScroll: true }); focusGuide.current = false; });
    return () => cancelAnimationFrame(frame);
  }, [guideSection, collapsed]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !event.altKey && !event.isComposing) {
        // Do not steal focus from another modal or the mobile navigation drawer.
        if (document.querySelector('[aria-modal="true"]') || document.getElementById("aurora-search-trigger")?.closest("[inert]")) return;
        event.preventDefault(); setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);

  return (
    <DiscoveryContext.Provider value={{ searchOpen, openSearch: () => setSearchOpen(true), guideSection, explain }}>
      {children}
      {guideSection && !navigationOpen && <GuidePanel section={guideSection} current={current} step={step} setStep={setStep} collapsed={collapsed} setCollapsed={setCollapsed} titleRef={panelTitle} onClose={closeGuide} onSelect={explain} suspended={searchOpen} />}
      {searchOpen && <SearchDialog onClose={() => setSearchOpen(false)} />}
    </DiscoveryContext.Provider>
  );
}

export function DiscoveryToolbar() {
  const context = useContext(DiscoveryContext);
  if (!context) return null;
  return (
    <div className="aurora-discovery-toolbar mx-auto grid max-w-[1400px] items-center gap-2 px-4 py-2.5 sm:px-6 lg:px-8">
      <button id="aurora-search-trigger" type="button" onClick={context.openSearch} aria-haspopup="dialog" aria-expanded={context.searchOpen} aria-keyshortcuts="Meta+K Control+K" className="aurora-search-trigger flex min-h-11 min-w-0 items-center gap-3 rounded-sm border border-line-strong bg-surface px-3.5 text-left text-text-2 transition-colors hover:bg-surface-inset">
        <Search className="h-[18px] w-[18px] shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 text-[14px] leading-snug">Поиск по Авроре</span>
        <kbd aria-hidden className="hidden shrink-0 rounded border border-line px-1.5 py-0.5 font-sans text-[12px] text-text-3 sm:block">⌘ / Ctrl K</kbd>
      </button>
      <button id="aurora-guide-trigger" type="button" onClick={() => context.explain()} aria-label="Гид Авроры — объяснить экран" aria-expanded={Boolean(context.guideSection)} aria-controls={context.guideSection ? "aurora-guide-panel" : undefined} className="aurora-guide-trigger flex min-h-11 items-center justify-center gap-2 rounded-sm px-1.5 text-text-2 transition-colors hover:bg-surface-inset sm:px-3">
        <Avatar />
        <span className="hidden text-left sm:block"><span className="block text-[13px] font-semibold text-text">Гид Авроры</span><span className="block text-[12px]">Объяснить экран</span></span>
      </button>
    </div>
  );
}

/** Explanation buttons appear only while help is enabled; ordinary navigation remains a link. */
export function DiscoveryNavHelp({ section, onSelect }: { section: AppNavRouteId; onSelect?: () => void }) {
  const context = useContext(DiscoveryContext);
  if (!context?.guideSection) return null;
  return <button type="button" onClick={() => { onSelect?.(); context.explain(section); }} aria-label={`Объяснить раздел «${APP_ROUTES[section].label}»`} className="grid h-11 w-11 shrink-0 place-items-center rounded-xs text-text-2 hover:bg-surface-inset hover:text-text"><CircleHelp className="h-[18px] w-[18px]" aria-hidden /></button>;
}

function SearchDialog({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | DiscoveryEntry["kind"]>("all");
  const [message, setMessage] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const inputId = useId();
  const resultsId = useId();
  const { overlayRef, dialogRef, onKeyDown } = useModalFocus({ open: true, initialFocusRef: inputRef, restoreFocusId: "aurora-search-trigger", onEscape: onClose });
  const results = searchDiscovery(query).filter((entry) => filter === "all" || entry.kind === filter);

  function beforeNavigate(event: { preventDefault: () => void }) {
    if (document.querySelector('[data-settings-dirty="true"]')) {
      event.preventDefault();
      setMessage("Сохраните или отмените изменения в настройках, затем повторите переход.");
      return;
    }
    onClose();
  }

  return (
    <div ref={overlayRef} className="aurora-search-overlay fixed inset-0 z-[100] flex items-start justify-center overscroll-contain bg-black/45 p-3 sm:items-center sm:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="aurora-search-dialog flex w-full max-w-[680px] flex-col overflow-hidden rounded-md border border-line-strong bg-surface text-text shadow-float" onKeyDown={(event) => {
        onKeyDown(event);
        if (event.defaultPrevented || event.nativeEvent.isComposing) return;
        const links = Array.from(dialogRef.current?.querySelectorAll<HTMLAnchorElement>("[data-discovery-result]") ?? []);
        if (!links.length) return;
        const active = document.activeElement;
        if (event.key === "Enter" && active === inputRef.current) { event.preventDefault(); links[0].click(); return; }
        if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
        const index = links.findIndex((link) => link === active);
        if (active !== inputRef.current && index === -1) return;
        event.preventDefault();
        if (event.key === "ArrowUp" && index <= 0) { inputRef.current?.focus(); return; }
        links[Math.min(links.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))]?.focus();
      }}>
        <div className="shrink-0 border-b border-line p-4 sm:p-5">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div><h2 id={titleId} className="text-[18px] font-semibold">Найдите нужное в Авроре</h2><p className="mt-1 text-[13px] leading-relaxed text-text-2">Разделы, функции и настройки платформы</p></div>
            <Button variant="ghost" size="icon" aria-label="Закрыть поиск" onClick={onClose} className="shrink-0"><X className="h-5 w-5" aria-hidden /></Button>
          </div>
          <label htmlFor={inputId} className="mb-2 block text-[13px] font-semibold">Что хотите сделать?</label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-text-3" aria-hidden />
            <Input id={inputId} ref={inputRef} type="search" value={query} maxLength={200} onChange={(event) => { setQuery(event.target.value); setMessage(""); }} placeholder="Например, написать пост" autoComplete="off" aria-controls={resultsId} className="pl-11 text-base" />
          </div>
          <div role="group" aria-label="Тип результатов" className="mt-3 flex flex-wrap gap-2">
            {([["all", "Всё"], ["section", "Разделы"], ["action", "Действия"]] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)} className={cn("min-h-11 rounded-xs border px-3 text-[13px] font-medium", filter === value ? "border-line-strong bg-surface-inset text-text" : "border-transparent text-text-2 hover:bg-surface-inset")}>{label}</button>)}
          </div>
        </div>
        <div id={resultsId} className="min-h-0 overflow-y-auto overscroll-contain p-3 sm:px-5" tabIndex={0} aria-label="Результаты поиска">
          <p role="status" className="px-1 pb-2 text-[12px] text-text-2">{query.trim() ? `Найдено: ${results.length}` : filter === "section" ? "Разделы платформы" : "Начните с действия или введите запрос"}</p>
          {message && <p role="alert" className="mb-3 rounded-sm bg-surface-inset p-3 text-[14px] leading-relaxed">{message}</p>}
          {results.length ? <ul className="space-y-1">{results.map((entry) => <li key={entry.id} className="rounded-sm border border-transparent p-1 hover:border-line hover:bg-surface-inset focus-within:border-line-strong">
            <Link href={entry.href} prefetch={false} onNavigate={beforeNavigate} data-discovery-result className="flex min-h-11 items-start gap-3 rounded-xs p-2">
              <span className="mt-0.5 text-text-2">{entry.kind === "section" ? <BookOpen className="h-[18px] w-[18px]" aria-hidden /> : <ArrowRight className="h-[18px] w-[18px]" aria-hidden />}</span>
              <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold leading-snug">{entry.label}</span><span className="mt-1 block text-[13px] leading-relaxed text-text-2">{entry.description}</span></span>
            </Link>
            <div className="flex flex-wrap items-center justify-between gap-x-3 px-2 pl-10">
              <span className="text-[12px] text-text-3">{entry.kind === "section" ? "Раздел" : APP_ROUTES[entry.sectionId].label}</span>
              <Link href={guideHref(entry)} prefetch={false} onNavigate={beforeNavigate} aria-label={`${SECTION_HELP[entry.sectionId].steps ? "Показать, как" : "Объяснить"}: ${entry.label}`} className="inline-flex min-h-11 items-center gap-1.5 rounded-xs px-2 text-[13px] font-medium text-info-text hover:underline"><CircleHelp className="h-4 w-4" aria-hidden />{SECTION_HELP[entry.sectionId].steps ? "Показать, как" : "Объяснить"}</Link>
            </div>
          </li>)}</ul> : <div className="px-2 py-6"><p className="text-[15px] font-semibold">Ничего не найдено</p><p className="mt-2 text-[14px] leading-relaxed text-text-2">Попробуйте название раздела или короткое действие: «написать пост», «подключить канал».</p><Button variant="secondary" size="sm" className="mt-4" onClick={() => { setQuery(""); setFilter("all"); inputRef.current?.focus(); }}>Сбросить поиск</Button></div>}
        </div>
        <p className="hidden shrink-0 border-t border-line px-5 py-3 text-[12px] text-text-3 sm:block">↑ ↓ — выбрать результат · Enter — открыть · Esc — закрыть</p>
      </div>
    </div>
  );
}

function GuidePanel({ section, current, step, setStep, collapsed, setCollapsed, titleRef, onClose, onSelect, suspended }: {
  section: AppNavRouteId; current?: AppNavRouteId; step: number | null; setStep: (step: number | null) => void;
  collapsed: boolean; setCollapsed: (collapsed: boolean) => void; titleRef: React.RefObject<HTMLHeadingElement | null>;
  onClose: () => void; onSelect: (section: AppNavRouteId) => void; suspended: boolean;
}) {
  const titleId = useId();
  const selectId = useId();
  const contentId = useId();
  const [targetFound, setTargetFound] = useState(false);
  const [navigationMessage, setNavigationMessage] = useState("");
  const collapseRef = useRef<HTMLButtonElement>(null);
  const { stageRef, headerRef, rect: windowRect, interaction, announcement, start, reset, onKeyDown: windowKeyDown, pointerHandlers, cancelGesture } = useGuideWindow(collapsed);
  const moveHintId = useId();
  const resizeHintId = useId();
  const help = SECTION_HELP[section];
  const activeStep = step !== null && current === section ? help.steps?.[step] : undefined;
  const activeEntry = DISCOVERY_SECTIONS.find((entry) => entry.sectionId === section)!;

  useEffect(() => {
    if (!activeStep || suspended) return;
    let highlighted: HTMLElement | null = null;
    const reveal = () => {
      const target = Array.from(document.querySelectorAll<HTMLElement>(activeStep.target)).find((element) => element.getClientRects().length > 0 && !element.closest('[hidden], [inert]'));
      setTargetFound(Boolean(target));
      if (!target) return false;
      highlighted = target;
      target.dataset.discoveryHighlight = "true";
      target.scrollIntoView({ block: "nearest", behavior: "instant" });
      return true;
    };
    const observer = new MutationObserver(() => { if (reveal()) observer.disconnect(); });
    const frame = requestAnimationFrame(() => { if (!reveal()) observer.observe(document.getElementById("main") ?? document.body, { childList: true, subtree: true }); });
    const deadline = window.setTimeout(() => observer.disconnect(), 8000);
    return () => { cancelAnimationFrame(frame); clearTimeout(deadline); observer.disconnect(); if (highlighted) delete highlighted.dataset.discoveryHighlight; };
  }, [activeStep, suspended]);

  return (
    <div ref={stageRef} className="aurora-guide-stage">
    <aside id="aurora-guide-panel" aria-labelledby={titleId} data-collapsed={collapsed} data-interaction={interaction ?? undefined}
      style={windowRect ? { left: windowRect.x, top: windowRect.y, width: windowRect.width, height: collapsed ? undefined : windowRect.height, right: "auto", bottom: "auto" } : undefined}
      className="aurora-guide-panel shadow-float" {...pointerHandlers}
      onKeyDown={(event) => { if (event.key === "Escape" && !event.defaultPrevented) { event.stopPropagation(); event.preventDefault(); if (!cancelGesture()) onClose(); } }}>
      <div ref={headerRef} className="aurora-guide-header" onPointerDown={(event) => {
        if (!(event.target as HTMLElement).closest("button")) start(event, "move");
      }}>
        <button type="button" className="aurora-guide-move" aria-label="Переместить окно гида" aria-describedby={moveHintId}
          onPointerDown={(event) => start(event, "move")} onKeyDown={(event) => windowKeyDown(event, "move")}>
          <Avatar /><GripHorizontal className="aurora-guide-grip" size={14} aria-hidden />
        </button>
        <div className="aurora-guide-heading"><h2 id={titleId} ref={titleRef} tabIndex={-1}>Гид Авроры</h2><p>{collapsed ? APP_ROUTES[section].label : "Перетащите за шапку"}</p></div>
        <div className="aurora-guide-header-actions">
          <Button ref={collapseRef} variant="ghost" size="icon" aria-label={collapsed ? "Развернуть гида" : "Свернуть гида"} aria-expanded={!collapsed} aria-controls={!collapsed ? contentId : undefined} onClick={() => setCollapsed(!collapsed)}>{collapsed ? <Plus className="h-4 w-4" aria-hidden /> : <Minus className="h-4 w-4" aria-hidden />}</Button>
          <Button variant="ghost" size="icon" aria-label="Закрыть гида" onClick={onClose}><X className="h-4 w-4" aria-hidden /></Button>
        </div>
      </div>
      <span id={moveHintId} className="sr-only">Перетащите мышью или используйте стрелки. Shift увеличивает шаг. Home возвращает исходный вид.</span>
      <span id={resizeHintId} className="sr-only">Потяните за угол. С клавиатуры: влево и вправо — ширина, вверх и вниз — высота. Shift увеличивает шаг. Home возвращает исходный вид.</span>
      <span role="status" className="sr-only">{announcement}</span>
      {!collapsed && <div id={contentId} className="aurora-guide-body">
        {!activeStep ? <>
          <label htmlFor={selectId} className="mb-2 block text-[12px] font-medium text-text-2">Какой раздел объяснить?</label>
          <select id={selectId} value={section} onChange={(event) => { setNavigationMessage(""); onSelect(event.target.value as AppNavRouteId); }} className="min-h-11 w-full rounded-xs border border-line-strong bg-surface px-3 text-base text-text">
            {DISCOVERY_SECTIONS.map((entry) => <option key={entry.id} value={entry.sectionId}>{entry.label}</option>)}
          </select>
          <p className="aurora-guide-description">{help.description}</p>
          <div className="aurora-guide-first-step"><h3 className="text-[13px] font-semibold">С чего начать</h3><p className="mt-1 text-[13px] leading-relaxed text-text-2">{help.firstStep}</p></div>
          <div className="aurora-guide-actions">
            {current === section && help.steps ? <Button variant="primary" size="sm" onClick={() => setStep(0)}>Показать, как<ArrowRight className="h-4 w-4" aria-hidden /></Button> : current !== section ? <Link href={help.steps ? guideHref(activeEntry) : activeEntry.href} prefetch={false} onNavigate={(event) => { if (document.querySelector('[data-settings-dirty="true"]')) { event.preventDefault(); setNavigationMessage("Сохраните или отмените изменения в настройках перед переходом."); } }} className={buttonClassName({ variant: "primary", size: "sm" })}>{help.steps ? "Открыть и показать" : "Открыть раздел"}<ArrowRight className="h-4 w-4" aria-hidden /></Link> : null}
            <Button variant="ghost" size="sm" onClick={onClose}>Понятно</Button>
          </div>
          {navigationMessage && <p role="alert" className="mt-3 text-[13px] leading-relaxed text-text-2">{navigationMessage}</p>}
          <p className="aurora-guide-note">Пока гид открыт, кнопки «?» в меню объясняют разделы.</p>
        </> : <>
          <div aria-live="polite" aria-atomic="true" className="aurora-guide-step">
            <div className="aurora-guide-progress" aria-hidden>{help.steps!.map((_, index) => <span key={index} data-complete={index <= step!} />)}</div>
            <p className="text-[12px] font-medium tabular-nums text-text-2">{APP_ROUTES[section].label} · Шаг {step! + 1} из {help.steps!.length}</p>
            <h3 className="mt-2 text-[17px] font-semibold leading-snug">{activeStep.title}</h3>
            <p className="mt-3 text-[14px] leading-relaxed text-text-2">{activeStep.body}</p>
            <p className="mt-3 rounded-sm bg-surface-inset p-3 text-[13px] leading-relaxed text-text-2">{targetFound ? "Нужный элемент выделен рамкой. Гид не выполняет действия за вас." : activeStep.unavailable}</p>
          </div>
          {targetFound && <Button variant="ghost" size="sm" className="mt-2" onClick={() => { setCollapsed(true); requestAnimationFrame(() => collapseRef.current?.focus({ preventScroll: true })); }}>Свернуть и посмотреть экран</Button>}
          <div className="aurora-guide-actions aurora-guide-step-actions">
            <Button size="sm" variant="ghost" onClick={() => setStep(step! > 0 ? step! - 1 : null)}><ChevronLeft className="h-4 w-4" aria-hidden />Назад</Button>
            <Button size="sm" variant="primary" onClick={() => step! + 1 < help.steps!.length ? setStep(step! + 1) : onClose()}>{step! + 1 < help.steps!.length ? "Далее" : "Завершить"}</Button>
          </div>
        </>}
      </div>}
      {!collapsed && <>
        <div className="aurora-guide-footer">
          <button type="button" className="aurora-guide-reset" onClick={reset}><RotateCcw size={15} aria-hidden />Сбросить вид</button>
          <span className="aurora-guide-resize-note">Потяните за угол</span>
          <button type="button" className="aurora-guide-resize" aria-label="Изменить размер окна гида" aria-describedby={resizeHintId}
            onPointerDown={(event) => start(event, "resize")} onKeyDown={(event) => windowKeyDown(event, "resize")}><MoveDiagonal2 size={20} aria-hidden /></button>
        </div>
        <button type="button" className="aurora-guide-resize-start" aria-label="Изменить размер от верхнего левого угла" aria-describedby={resizeHintId}
          onPointerDown={(event) => start(event, "resize-start")} onKeyDown={(event) => windowKeyDown(event, "resize")}><MoveDiagonal2 size={14} aria-hidden /></button>
      </>}
    </aside>
    </div>
  );
}
