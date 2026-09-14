// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Circle } from "lucide-react";
import { APP_NAV_GROUPS } from "@/lib/app-routes";
import { NAV_CHILDREN } from "@/lib/sidebar-navigation";
import { SidebarNavigation } from "./sidebar-navigation";

const fixture = vi.hoisted(() => ({ query: "", reduced: true, navigate: vi.fn(), animate: vi.fn(), cancel: vi.fn() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(fixture.query) }));
vi.mock("motion/react", () => ({ useReducedMotion: () => fixture.reduced, animate: fixture.animate }));
vi.mock("./aurora-discovery", () => ({ DiscoveryNavHelp: () => null }));
vi.mock("next/link", () => ({ default: ({ href, onClick, onNavigate, prefetch, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { onNavigate?: (event: { preventDefault: () => void }) => void; prefetch?: boolean }) => {
  void prefetch;
  return <a {...props} href={href} onClick={(event) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    let blocked = false;
    onNavigate?.({ preventDefault: () => { blocked = true; } });
    if (!blocked) fixture.navigate(href);
  }} />;
} }));
const groups = APP_NAV_GROUPS.map((group) => ({ title: group.title, items: group.routeIds.map((routeId) => ({ routeId, icon: Circle, children: NAV_CHILDREN[routeId] })) }));
beforeEach(() => {
  vi.stubGlobal("React", React);
  fixture.query = ""; fixture.reduced = true;
  fixture.navigate.mockReset(); fixture.cancel.mockReset(); fixture.animate.mockReset().mockReturnValue({ cancel: fixture.cancel });
  vi.stubGlobal("requestAnimationFrame", () => 1); vi.stubGlobal("cancelAnimationFrame", vi.fn());
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: true }) });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const parent = (name: string) => screen.getByRole("button", { name });
const panel = (name: string) => document.getElementById(parent(name).getAttribute("aria-controls")!)!;
function mount(pathname = "/app/studio", onClose = vi.fn()) {
  return { ...render(<SidebarNavigation groups={groups} pathname={pathname} unreadCount={5} onClose={onClose} />), onClose };
}

describe("real sidebar navigation interactions", () => {
  it("retains all 16 sections and 15 nested destinations, opening only the active branch", () => {
    const view = mount();
    expect(view.container.querySelectorAll(".aurora-sidebar-item")).toHaveLength(16);
    expect(view.container.querySelectorAll(".aurora-sidebar-child")).toHaveLength(15);
    expect(view.container.querySelectorAll('[data-open="true"]')).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Чат" }).getAttribute("aria-current")).toBe("page");
  });
  it("opening another branch never navigates or closes the mobile drawer", () => {
    const view = mount(); fireEvent.click(parent("Автопилот"));
    expect(parent("Автопилот").getAttribute("aria-expanded")).toBe("true");
    expect(panel("Студия контента").hasAttribute("inert")).toBe(true);
    expect(fixture.navigate).not.toHaveBeenCalled(); expect(view.onClose).not.toHaveBeenCalled();
  });
  it("uses the URL after navigation, query-only changes and browser back", () => {
    const view = mount(); fireEvent.click(parent("Автопилот"));
    fixture.query = "view=saved&channel=42";
    view.rerender(<SidebarNavigation groups={groups} pathname="/app/rss" unreadCount={5} />);
    expect(screen.getByRole("link", { name: "Сохранённые" }).getAttribute("aria-current")).toBe("page");
    fixture.query = "view=used&channel=42";
    view.rerender(<SidebarNavigation groups={groups} pathname="/app/rss" unreadCount={5} />);
    expect(screen.getByRole("link", { name: "Использованные" }).getAttribute("aria-current")).toBe("page");
    fixture.query = ""; view.rerender(<SidebarNavigation groups={groups} pathname="/app/studio" unreadCount={5} />);
    expect(parent("Студия контента").getAttribute("aria-expanded")).toBe("true");
  });
  it("preserves the channel and closes the drawer only on normal link navigation", () => {
    fixture.query = "channel=42"; const view = mount("/app/rss");
    const link = screen.getByRole("link", { name: "Сохранённые" });
    fireEvent.click(link, { metaKey: true }); expect(view.onClose).not.toHaveBeenCalled();
    fireEvent.click(link); expect(fixture.navigate).toHaveBeenCalledWith("/app/rss?view=saved&channel=42");
    expect(view.onClose).toHaveBeenCalledTimes(1);
  });
  it("Escape collapses the subtree, restores focus and does not bubble into the drawer", () => {
    mount(); const bubble = vi.fn(); document.addEventListener("keydown", bubble);
    fireEvent.keyDown(screen.getByRole("link", { name: "Чат" }), { key: "Escape" });
    expect(document.activeElement).toBe(parent("Студия контента"));
    expect(panel("Студия контента").hasAttribute("inert")).toBe(true);
    expect(bubble).not.toHaveBeenCalled(); document.removeEventListener("keydown", bubble);
  });
  it("does not follow a different row under the second click while the list reflows", () => {
    mount(); const trigger = parent("Автопилот");
    fireEvent.click(trigger, { detail: 1, clientX: 80, clientY: 220 });
    fireEvent.click(screen.getByRole("link", { name: "Редактор" }), { detail: 1, clientX: 80, clientY: 220 });
    expect(fixture.navigate).not.toHaveBeenCalled(); expect(document.activeElement).toBe(trigger);
    fireEvent.click(screen.getByRole("link", { name: "Редактор" }), { detail: 0 });
    expect(fixture.navigate).toHaveBeenCalledWith("/app/composer");
  });
  it("keeps dirty settings intact and explains a blocked navigation", () => {
    const view = mount("/app/settings"); const dirty = document.createElement("div"); dirty.dataset.settingsDirty = "true"; document.body.append(dirty);
    fireEvent.click(screen.getByRole("link", { name: "Календарь" }));
    expect(fixture.navigate).not.toHaveBeenCalled(); expect(view.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Сохраните или отмените"); dirty.remove();
  });
  it("skips reduced motion and cancels the previous icon sequence on rapid selection and unmount", () => {
    const view = mount(); fireEvent.click(parent("Автопилот")); expect(fixture.animate).not.toHaveBeenCalled();
    fixture.reduced = false; view.rerender(<SidebarNavigation groups={groups} pathname="/app/studio" unreadCount={5} />);
    fireEvent.click(parent("Идеи и примеры")); fireEvent.click(parent("Настройки"));
    expect(fixture.animate).toHaveBeenCalledTimes(2); expect(fixture.cancel).toHaveBeenCalled();
    fixture.cancel.mockClear(); view.unmount(); expect(fixture.cancel).toHaveBeenCalled();
  });
});
