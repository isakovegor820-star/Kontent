// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuroraDiscovery, DiscoveryNavHelp, DiscoveryToolbar } from "./aurora-discovery";

const navigation = vi.hoisted(() => ({ pathname: "/app/calendar", query: "", navigate: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname, useSearchParams: () => new URLSearchParams(navigation.query) }));
// eslint-disable-next-line @next/next/no-img-element -- render the Next image as a native image in jsdom
vi.mock("next/image", () => ({ default: (props: React.ImgHTMLAttributes<HTMLImageElement>) => <img {...props} alt={props.alt ?? ""} /> }));
vi.mock("next/link", () => ({ default: ({ href, onNavigate, prefetch, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { onNavigate?: (event: { preventDefault: () => void }) => void; prefetch?: boolean }) => { void prefetch; return <a {...props} href={href} onClick={(event) => { event.preventDefault(); let cancelled = false; onNavigate?.({ preventDefault: () => { cancelled = true; } }); if (!cancelled) navigation.navigate(href); }} />; } }));

beforeEach(() => {
  navigation.pathname = "/app/calendar"; navigation.query = ""; navigation.navigate.mockReset();
  vi.stubGlobal("React", React);
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount() {
  return render(<AuroraDiscovery><main id="main"><DiscoveryToolbar /><DiscoveryNavHelp section="studio" /><button id="unrelated">Обычное действие</button></main></AuroraDiscovery>);
}

describe("search and guide interactions", () => {
  it("opens by shortcut, traps focus, closes on Escape and restores focus", async () => {
    mount(); const trigger = screen.getByRole("button", { name: "Поиск по Авроре" }); trigger.focus();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = await screen.findByRole("searchbox");
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(document.getElementById("main")?.inert).toBe(true);
    const close = screen.getByRole("button", { name: "Закрыть поиск" }); close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect((document.activeElement as HTMLElement).getAttribute("href")).toContain("guide=settings");
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(document.getElementById("main")?.inert).not.toBe(true);
  });
  it("offers arrow navigation, filters and reset after an empty result", () => {
    mount(); fireEvent.click(screen.getByRole("button", { name: "Поиск по Авроре" }));
    const input = screen.getByRole("searchbox"); fireEvent.change(input, { target: { value: "подключить канал" } });
    input.focus(); fireEvent.keyDown(input, { key: "ArrowDown" });
    expect((document.activeElement as HTMLAnchorElement).getAttribute("href")).toBe("/app/settings?section=channels&setting=channels");
    fireEvent.click(screen.getByRole("button", { name: "Разделы" }));
    expect(screen.queryByRole("link", { name: /^Подключить канал/ })).toBeNull();
    fireEvent.change(input, { target: { value: "zzzzzzz" } });
    expect(screen.getByText("Ничего не найдено")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить поиск" }));
    expect((input as HTMLInputElement).value).toBe("");
  });
  it("does not navigate away from unsaved settings", () => {
    mount(); document.getElementById("unrelated")!.dataset.settingsDirty = "true";
    fireEvent.click(screen.getByRole("button", { name: "Поиск по Авроре" }));
    fireEvent.click(screen.getByRole("link", { name: /^Написать пост/ }));
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Сохраните или отмените");
  });
  it("explains menu sections without navigation and removes hints when closed", async () => {
    mount(); expect(screen.queryByRole("button", { name: /Объяснить раздел/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Гид Авроры — объяснить экран" }));
    fireEvent.click(screen.getByRole("button", { name: "Объяснить раздел «Студия контента»" }));
    expect(screen.getByText(/Подготовка контента с Авророй/)).toBeTruthy();
    expect(navigation.navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть гида" }));
    expect(screen.queryByRole("button", { name: /Объяснить раздел/ })).toBeNull();
  });
  it("handles absent targets, completes a tour and never executes page actions", async () => {
    navigation.query = "guide=calendar"; mount();
    expect(screen.getByText("Посмотрите расписание")).toBeTruthy();
    expect(screen.getByText(/Расписание появится после загрузки/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    expect(screen.getByText("Подготовьте новый пост")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    fireEvent.click(screen.getByRole("button", { name: "Завершить" }));
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(navigation.navigate).not.toHaveBeenCalled();
  });
  it("ignores invalid or unrelated guide URLs and does not steal another modal's shortcut", () => {
    navigation.query = "guide=settings"; mount();
    expect(screen.queryByRole("complementary")).toBeNull();
    const other = document.createElement("div"); other.setAttribute("aria-modal", "true"); document.body.append(other);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.queryByRole("searchbox")).toBeNull(); other.remove();
  });
  it("preserves form state when opening or closing a guide through URL navigation", async () => {
    function Draft() { const [text, setText] = React.useState(""); return <input aria-label="Черновик" value={text} onChange={(event) => setText(event.target.value)} />; }
    const tree = () => <AuroraDiscovery><DiscoveryToolbar /><Draft /></AuroraDiscovery>;
    const view = render(tree());
    fireEvent.change(screen.getByRole("textbox", { name: "Черновик" }), { target: { value: "Несохранённый текст" } });
    navigation.query = "guide=calendar"; view.rerender(tree());
    await screen.findByRole("complementary");
    navigation.query = ""; view.rerender(tree());
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    expect((screen.getByRole("textbox", { name: "Черновик" }) as HTMLInputElement).value).toBe("Несохранённый текст");
  });
});
