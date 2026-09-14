// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn() }));
vi.mock("@/lib/project-fetch", () => ({ projectFetch: mocks.fetch }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }), useSearchParams: () => new URLSearchParams("section=integrations") }));
vi.mock("@/components/app/shell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/app/use-oauth-return-project", () => ({ useOAuthReturnProject: () => "idle" }));
vi.mock("@/lib/store", () => ({ useStore: () => ({ ready: true, toast: mocks.toast, refreshReal: vi.fn() }) }));
vi.mock("@/components/app/tracking-settings-section", () => ({ TrackingSettingsSection: () => null }));
vi.mock("@/components/app/legal-sources-section", () => ({ LegalSourcesSection: () => null }));
import SettingsPage from "./page";

function status(linked: boolean, botStatus = "up", connectionKey = "a".repeat(32)) {
  return Response.json({ linked, connectionKey: linked ? connectionKey : null, botStatus, bot: "aurora_bot", channelConnectUrl: "https://t.me/aurora_bot?startchannel&admin=post_messages" });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
  mocks.fetch.mockImplementation(async () => status(true));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("returning to bot settings", () => {
  it("opens a connected bot as a native link without another connection request", async () => {
    render(<SettingsPage />);
    const link = await screen.findByRole("link", { name: "Открыть бота" });
    expect(link.getAttribute("href")).toBe("https://t.me/aurora_bot");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(screen.queryByRole("button", { name: "Подключить бота" })).toBeNull();
    expect(mocks.fetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it("refreshes the saved connection when returning from Telegram after the initial polling window", async () => {
    mocks.fetch.mockImplementation(async () => status(false));
    render(<SettingsPage />);
    await screen.findByRole("button", { name: "Подключить бота" });
    mocks.fetch.mockImplementation(async () => status(true));
    fireEvent.focus(window);
    await screen.findByRole("link", { name: "Открыть бота" });
    expect(screen.queryByRole("button", { name: "Подключить бота" })).toBeNull();
  });

  it("refreshes on a visible tab and removes the listeners on unmount", async () => {
    mocks.fetch.mockImplementation(async () => status(false));
    const view = render(<SettingsPage />);
    await screen.findByRole("button", { name: "Подключить бота" });
    mocks.fetch.mockImplementation(async () => status(true));
    fireEvent(document, new Event("visibilitychange"));
    await screen.findByRole("link", { name: "Открыть бота" });
    view.unmount();
    mocks.fetch.mockClear();
    fireEvent.focus(window);
    fireEvent(document, new Event("visibilitychange"));
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("does not overwrite a newer linked result with a delayed unlinked response", async () => {
    let resolveOld!: (response: Response) => void;
    mocks.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOld = resolve; }));
    render(<SettingsPage />);
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
    fireEvent.focus(window);
    await screen.findByRole("link", { name: "Открыть бота" });
    await act(async () => { resolveOld(status(false)); });
    expect(screen.getByRole("link", { name: "Открыть бота" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Подключить бота" })).toBeNull();
  });

  it("keeps the saved connection visible when the worker is unavailable", async () => {
    mocks.fetch.mockImplementation(async () => status(true, "down"));
    render(<SettingsPage />);
    await screen.findByText("Чат привязан, бот не отвечает");
    expect(screen.getByRole("link", { name: "Открыть бота" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Подключить бота" })).toBeNull();
  });

  it("does not race a focus refresh against an explicit disconnect", async () => {
    let finishDisconnect!: (response: Response) => void;
    mocks.fetch.mockImplementation(async (_url, init) => init?.method === "DELETE"
      ? new Promise<Response>((resolve) => { finishDisconnect = resolve; })
      : status(true));
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Отвязать чат" }));
    fireEvent.click(await screen.findByRole("button", { name: "Отключить чат" }));
    await waitFor(() => expect(mocks.fetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true));
    const calls = mocks.fetch.mock.calls.length;
    fireEvent.focus(window);
    expect(mocks.fetch).toHaveBeenCalledTimes(calls);
    await act(async () => { finishDisconnect(Response.json({ ok: true })); });
    await screen.findByRole("button", { name: "Подключить бота" });
    expect(screen.queryByRole("link", { name: "Открыть бота" })).toBeNull();
  });

  it("preserves the connection when confirmation is cancelled and restores keyboard focus", async () => {
    render(<SettingsPage />);
    const trigger = await screen.findByRole("button", { name: "Отвязать чат" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Отключить чат от Авроры?" });
    const cancel = screen.getByRole("button", { name: "Отмена" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Отключить чат" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(mocks.fetch.mock.calls.every(([, init]) => init?.method !== "DELETE")).toBe(true);
    expect(screen.getByRole("link", { name: "Открыть бота" })).toBeTruthy();
  });

  it("submits the connection shown when confirmation opened even if a focus refresh sees another one", async () => {
    mocks.fetch.mockImplementation(async (_url, init) => init?.method === "DELETE"
      ? Response.json({ ok: false, error: "connection_changed" }, { status: 409 }) : status(true));
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Отвязать чат" }));
    mocks.fetch.mockImplementationOnce(async () => status(true, "up", "b".repeat(32)));
    await act(async () => { fireEvent.focus(window); });
    fireEvent.click(screen.getByRole("button", { name: "Отключить чат" }));
    await screen.findByText("Не удалось проверить связь с ботом");
    const request = mocks.fetch.mock.calls.find(([, init]) => init?.method === "DELETE");
    expect(JSON.parse(request![1].body)).toEqual({ confirm: true, connectionKey: "a".repeat(32) });
    expect(screen.queryByRole("button", { name: "Подключить бота" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await screen.findByRole("link", { name: "Открыть бота" });
  });

  it("offers retry instead of claiming the account is unlinked on a failed status read", async () => {
    mocks.fetch.mockResolvedValue(Response.json({ error: "server" }, { status: 500 }));
    render(<SettingsPage />);
    await screen.findByText("Не удалось проверить связь с ботом");
    expect(screen.getByRole("button", { name: "Повторить" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Подключить бота" })).toBeNull();
  });

  it("accepts a connection completed elsewhere instead of instructing the user to start again", async () => {
    mocks.fetch.mockImplementation(async (_url, init) => init?.method === "POST"
      ? Response.json({ ok: true, linked: true, url: "https://t.me/aurora_bot" })
      : status(false));
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Подключить бота" }));
    await screen.findByRole("link", { name: "Открыть бота" });
    expect(open).toHaveBeenCalledWith("https://t.me/aurora_bot", "_blank", "noopener");
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Бот уже подключён" }));
  });
});
