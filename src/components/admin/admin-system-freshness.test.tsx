// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminSystemCenter } from "./admin-system-center";
import { systemPayload } from "./__fixtures__/admin-payloads";

const fetchMock = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-03T10:00:00Z"));
  vi.stubGlobal("fetch", fetchMock);
  window.history.replaceState({}, "", "/admin?system=redis#system");
  window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as never;
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
async function flush() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
function success() { return { ok: true, status: 200, json: async () => systemPayload() }; }

describe("system freshness through rendered cards and queue details", () => {
  it("distinguishes a fresh check with old execution evidence from an expired snapshot", async () => {
    const payload = systemPayload();
    const components = payload.components.map(component => component.id === "redis" ? { ...component, state: "stale" as const } : component);
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ...payload, state: "unobserved", components }) });
    render(<AdminSystemCenter />); await flush();
    expect(screen.getByRole("heading", { name: "Исправность подтверждена не полностью" })).toBeTruthy();
    expect(within(screen.getByRole("article")).getAllByText("Данные устарели").length).toBeGreaterThan(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    expect(screen.getByRole("heading", { name: "Состояние требует новой проверки" })).toBeTruthy();
  });
  it("expires healthy cards, summary and nested queue statuses", async () => {
    fetchMock.mockResolvedValue(success());
    render(<AdminSystemCenter />); await flush();
    expect(screen.getByText("Исправно:").textContent).toContain("10");
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    expect(screen.getByText("Исправно:").textContent).toContain("0");
    expect(screen.queryAllByText("Исправно")).toHaveLength(0);
    expect(within(screen.getByRole("article")).getAllByText("Данные устарели").length).toBeGreaterThan(0);
  });
  it("keeps counters on failed refresh, marks evidence unavailable, then recovers on a fresh response", async () => {
    fetchMock.mockResolvedValueOnce(success()).mockRejectedValueOnce(Error("network"));
    render(<AdminSystemCenter />); await flush();
    fireEvent.click(screen.getByRole("button", { name: "Обновить" })); await flush();
    expect(screen.getByRole("alert").textContent).toContain("Обновление не завершено");
    expect(screen.queryAllByText("Исправно")).toHaveLength(0);
    expect(within(screen.getByRole("article")).getByText("45,9 МБ")).toBeTruthy();
    fetchMock.mockResolvedValueOnce(success());
    fireEvent.click(screen.getByRole("button", { name: "Обновить" })); await flush();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Исправно:").textContent).toContain("10");
  });
  it("ends an initial request that never settles after 15 seconds", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    render(<AdminSystemCenter />);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.getByText("Диагностика недоступна")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Повторить попытку" })).toBeTruthy();
  });
});
