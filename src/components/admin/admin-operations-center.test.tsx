// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminAuroraAnalyticsCenter } from "./admin-aurora-analytics";
import { AdminDashboard } from "./admin-dashboard";
import { AdminSystemCenter } from "./admin-system-center";
import { adminFetchMock, analyticsPayload, overviewPayload, systemPayload } from "./__fixtures__/admin-payloads";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.setSystemTime(new Date("2026-09-03T10:00:00.000Z"));
  vi.stubGlobal("fetch", fetchMock);
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn();
  window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as never;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("AdminSystemCenter", () => {
  it("renders every diagnostic component and keeps configuration-only checks out of «исправно»", async () => {
    window.history.replaceState({}, "", "/admin#system");
    fetchMock.mockImplementation(adminFetchMock({ "/api/admin/system": () => systemPayload() }));
    render(<AdminSystemCenter />);
    expect(await screen.findByText("Платформа работает с отклонениями")).toBeTruthy();
    expect(screen.getByText("Исправно:").parentElement?.textContent).toContain("10");
    expect(screen.getByText("Настроено:").parentElement?.textContent).toContain("3");
    expect(screen.getAllByText("Настроено")).toHaveLength(3);
    expect(screen.getAllByRole("button", { expanded: false })).toHaveLength(15);
    expect(screen.getByText("Выберите компонент")).toBeTruthy();
  });

  it("opens a component through the URL and shows labelled, formatted metrics", async () => {
    window.history.replaceState({}, "", "/admin#system");
    fetchMock.mockImplementation(adminFetchMock({ "/api/admin/system": () => systemPayload() }));
    render(<AdminSystemCenter />);
    await screen.findByText("Платформа работает с отклонениями");
    fireEvent.click(screen.getByRole("button", { name: /Redis/u }));
    expect(window.location.search).toBe("?system=redis");
    const detail = await screen.findByRole("article");
    expect(within(detail).getByText("Занятая память")).toBeTruthy();
    expect(within(detail).getByText("45,9 МБ")).toBeTruthy();
    expect(within(detail).getByText("Uptime")).toBeTruthy();
    expect(within(detail).getByText("9 д 9 ч")).toBeTruthy();
    expect(within(detail).getByText("stats")).toBeTruthy();
    expect(within(detail).queryByText("usedMemoryBytes")).toBeNull();
  });

  it("ignores unknown component ids in the URL instead of showing an empty detail", async () => {
    window.history.replaceState({}, "", "/admin?system=autopilot_worker#system");
    fetchMock.mockImplementation(adminFetchMock({ "/api/admin/system": () => systemPayload() }));
    render(<AdminSystemCenter />);
    await screen.findByText("Платформа работает с отклонениями");
    expect(screen.getByText("Выберите компонент")).toBeTruthy();
    expect(screen.queryByRole("article")).toBeNull();
  });
});

describe("AdminAuroraAnalyticsCenter", () => {
  it("shows problems first and sections as a comparable table by default", async () => {
    window.history.replaceState({}, "", "/admin#aurora-analytics");
    fetchMock.mockImplementation(adminFetchMock({ "/api/admin/aurora-analytics": (params) => analyticsPayload(params) }));
    render(<AdminAuroraAnalyticsCenter />);
    expect(await screen.findByText("Автопилот: рост ошибок ai_provider_timeout")).toBeTruthy();
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(within(table).getByText("6,2%")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Таблица" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Карточки" }));
    expect(window.location.search).toBe("?analyticsView=cards");
    await waitFor(() => expect(screen.queryByRole("table")).toBeNull());
    expect(screen.getAllByText("Открыть аналитику")).toHaveLength(3);
  });

  it("opens the section detail from the table row and reflects it in the URL", async () => {
    window.history.replaceState({}, "", "/admin#aurora-analytics");
    fetchMock.mockImplementation(adminFetchMock({ "/api/admin/aurora-analytics": (params) => analyticsPayload(params) }));
    render(<AdminAuroraAnalyticsCenter />);
    await screen.findByRole("table");
    fireEvent.click(within(screen.getByRole("table")).getAllByRole("button", { name: "Открыть" })[2]);
    expect(window.location.search).toContain("analyticsSection=autopilot");
    expect(await screen.findByRole("heading", { level: 3, name: "Автопилот" })).toBeTruthy();
    expect(screen.getByText("Время до результата · p50")).toBeTruthy();
  });
});

describe("AdminDashboard shell", () => {
  it("keeps the shell and other sections usable when the overview query fails", async () => {
    window.history.replaceState({}, "", "/admin#overview");
    fetchMock.mockImplementation(adminFetchMock({ "/api/admin/overview": () => ({ status: 503 }), "/api/admin/aurora-analytics": () => ({ status: 503 }) }));
    render(<AdminDashboard />);
    expect(await screen.findByText("Сводка недоступна")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /Система/u }).length).toBeGreaterThan(0);
    expect(screen.queryByText("Пульс временно недоступен")).toBeNull();
  });

  it("does not request the overview for sections that do not render it", async () => {
    window.history.replaceState({}, "", "/admin#system");
    fetchMock.mockImplementation(adminFetchMock({ "/api/admin/system": () => systemPayload() }));
    render(<AdminDashboard />);
    await screen.findByText("Платформа работает с отклонениями");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/admin/overview"))).toBe(false);
    expect(screen.getByRole("heading", { level: 1, name: "Состояние системы" })).toBeTruthy();
  });

  it("renders actionable diagnostics links from the overview payload", async () => {
    window.history.replaceState({}, "", "/admin#overview");
    fetchMock.mockImplementation(adminFetchMock({
      "/api/admin/overview": () => overviewPayload(),
      "/api/admin/aurora-analytics": () => ({ status: 503 }),
    }));
    render(<AdminDashboard />);
    expect(await screen.findByRole("heading", { name: "Требует внимания" })).toBeTruthy();
    expect(await screen.findByText(/Ошибка отправки: «Открыли запись на приём»/u)).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Открыть публикацию" })).toHaveLength(2);
    expect(screen.getByText(/1 канал Telegram · требуется переподключение/u)).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Обзор" })).toBeTruthy();
    expect(screen.queryByText("Управление платформой")).toBeNull();
  });
});
