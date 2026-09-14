"use client";

import { useEffect, useId, useRef, useState, type MouseEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { animate, useReducedMotion } from "motion/react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { APP_ROUTES, isAppRouteActive, type AppNavRouteId } from "@/lib/app-routes";
import { activeChildHref, childHref, type NavChild } from "@/lib/sidebar-navigation";
import { plural } from "@/lib/utils";
import { DiscoveryNavHelp } from "./aurora-discovery";
import "./sidebar-navigation.css";

export type NavItem = { routeId: AppNavRouteId; icon: LucideIcon; children?: readonly NavChild[] };
export type NavGroup = { title: string; items: NavItem[] };

export function SidebarNavigation({ groups, pathname, unreadCount, onClose }: {
  groups: NavGroup[]; pathname: string; unreadCount: number; onClose?: () => void;
}) {
  const search = useSearchParams().toString();
  const routeKey = `${pathname}?${search}`;
  const activeItem = groups.flatMap((group) => group.items).find((item) => isAppRouteActive(pathname, item.routeId));
  const [branch, setBranch] = useState<{ key: string; id: AppNavRouteId | null } | null>(null);
  // Discard disclosure overrides on navigation, including when Back revisits this URL.
  if (branch && branch.key !== routeKey) setBranch(null);
  const expanded = branch?.key === routeKey ? branch.id : activeItem?.children ? activeItem.routeId : null;
  const [navigationError, setNavigationError] = useState("");
  const navRef = useRef<HTMLElement>(null);
  const id = useId();
  const reducedMotion = useReducedMotion();
  const animation = useRef<ReturnType<typeof animate> | null>(null);
  const lastReflow = useRef<{ at: number; x: number; y: number; target: HTMLElement } | null>(null);

  useEffect(() => {
    if (reducedMotion) animation.current?.cancel();
    return () => animation.current?.cancel();
  }, [reducedMotion]);

  // Reveal the route once, rather than observing/rescrolling on every animation frame.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const nav = navRef.current;
      const current = nav?.querySelector<HTMLElement>('[aria-current="page"]') ?? nav?.querySelector<HTMLElement>('[data-current="true"]');
      if (!nav || !current) return;
      const box = current.getBoundingClientRect();
      const viewport = nav.getBoundingClientRect();
      if (box.bottom > viewport.bottom) nav.scrollTop += box.bottom - viewport.bottom + 8;
      else if (box.top < viewport.top) nav.scrollTop -= viewport.top - box.top + 8;
    });
    return () => cancelAnimationFrame(frame);
  }, [routeKey]);

  function preventRepeatedPointer(event: MouseEvent<HTMLElement>) {
    const previous = lastReflow.current;
    if (event.detail === 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !previous) return false;
    if (event.timeStamp - previous.at >= 320 || Math.abs(event.clientX - previous.x) >= 5 || Math.abs(event.clientY - previous.y) >= 5) return false;
    event.preventDefault();
    previous.target.focus({ preventScroll: true });
    return true;
  }

  function playIcon(routeId: AppNavRouteId, element: HTMLElement) {
    animation.current?.cancel();
    if (reducedMotion || !window.matchMedia("(prefers-reduced-motion: no-preference)").matches) return;
    const glyph = element.closest(".aurora-sidebar-item")?.querySelector<HTMLElement>(".aurora-sidebar-icon");
    if (!glyph) return;
    const frames = routeId === "radar" ? { rotate: [0, 360] }
      : routeId === "autopilot" ? { y: [0, -2, 0], rotate: [0, -6, 0] }
      : routeId === "studio" ? { scale: [1, 1.13, 1], rotate: [0, 8, 0], opacity: [1, 0.7, 1] }
      : routeId === "settings" ? { rotate: [0, 35, 0] }
      : routeId === "composer" ? { x: [0, 2, 0], y: [0, -2, 0] }
      : { y: [0, -2, 0] };
    animation.current = animate(glyph, frames, { duration: routeId === "radar" ? 0.44 : 0.32, ease: "easeOut" });
  }

  function beforeNavigate(event: { preventDefault: () => void }) {
    if (document.querySelector('[data-settings-dirty="true"]')) {
      event.preventDefault();
      setNavigationError("Сохраните или отмените изменения в настройках, затем повторите переход.");
      return;
    }
    setNavigationError("");
    onClose?.();
  }

  return <nav ref={navRef} className="aurora-sidebar-nav" aria-label="Разделы платформы">
    {groups.map((group, groupIndex) => <section key={group.title} aria-labelledby={`${id}-group-${groupIndex}`}>
      <h2 id={`${id}-group-${groupIndex}`} className="aurora-sidebar-heading">{group.title}</h2>
      <ul className="aurora-sidebar-list">{group.items.map((item) => {
        const route = APP_ROUTES[item.routeId];
        const active = isAppRouteActive(pathname, item.routeId);
        const open = expanded === item.routeId;
        const currentChild = activeChildHref(item.routeId, pathname, search);
        const panelId = `${id}-${item.routeId}`;
        const Icon = item.icon;
        const rowContent = <>
          <span className="aurora-sidebar-icon" aria-hidden><Icon size={19} strokeWidth={1.6} /></span>
          <span className="aurora-sidebar-label">{route.label}</span>
          {item.routeId === "rss" && unreadCount > 0 && <>
            <span className="aurora-sidebar-count" aria-hidden>{unreadCount > 99 ? "99+" : unreadCount}</span>
            <span className="sr-only">{`, ${unreadCount} ${plural(unreadCount, "новый материал", "новых материала", "новых материалов")}`}</span>
          </>}
          {item.children && <ChevronRight className="aurora-sidebar-chevron" size={14} strokeWidth={1.6} aria-hidden />}
        </>;
        return <li key={item.routeId} className="aurora-sidebar-item" data-current={active}>
          <div className="aurora-sidebar-row">
            {item.children ? <button type="button" className="aurora-sidebar-action" aria-expanded={open} aria-controls={panelId}
              aria-current={active ? "location" : undefined}
              onClick={(event) => {
                if (preventRepeatedPointer(event)) return;
                if (event.detail > 0) lastReflow.current = { at: event.timeStamp, x: event.clientX, y: event.clientY, target: event.currentTarget };
                setBranch({ key: routeKey, id: open ? null : item.routeId });
                if (!open) playIcon(item.routeId, event.currentTarget); else animation.current?.cancel();
              }}>{rowContent}</button>
              : <Link href={route.href} className="aurora-sidebar-action" aria-current={active ? "page" : undefined}
                onClick={(event) => { if (!preventRepeatedPointer(event)) playIcon(item.routeId, event.currentTarget); }}
                onNavigate={beforeNavigate}>{rowContent}</Link>}
            <DiscoveryNavHelp section={item.routeId} onSelect={onClose} />
          </div>
          {item.children && <div id={panelId} className="aurora-sidebar-subtree" data-open={open} inert={!open}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault(); event.stopPropagation();
              event.currentTarget.closest("li")?.querySelector<HTMLButtonElement>(".aurora-sidebar-action")?.focus();
              setBranch({ key: routeKey, id: null });
            }}>
            <div className="aurora-sidebar-clip"><ul className="aurora-sidebar-children" aria-label={`${route.label} — подразделы`}>
              {item.children.map((child) => <li key={child.href}><Link href={childHref(child, new URLSearchParams(search))}
                prefetch={open ? undefined : false} className="aurora-sidebar-child" aria-current={active && currentChild === child.href ? "page" : undefined}
                onClick={(event) => { if (!preventRepeatedPointer(event)) playIcon(item.routeId, event.currentTarget); }}
                onNavigate={beforeNavigate}>{child.label}</Link></li>)}
            </ul></div>
          </div>}
        </li>;
      })}</ul>
    </section>)}
    {navigationError && <p role="alert" className="aurora-sidebar-error">{navigationError}</p>}
  </nav>;
}
