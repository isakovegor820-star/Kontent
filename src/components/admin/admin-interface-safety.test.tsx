// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminDashboard } from "./admin-dashboard";
import { AdminPublicationsCenter } from "./admin-publications-center";
import { AdminAiSpendCenter, usd } from "./admin-resource-centers";
import { adminFetchMock, overviewPayload } from "./__fixtures__/admin-payloads";

beforeEach(() => {
  vi.setSystemTime(new Date("2026-09-03T10:00:00.000Z"));
  Element.prototype.scrollIntoView = vi.fn(); Element.prototype.scrollTo = vi.fn();
  window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as never;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("admin interface trust and recovery", () => {
  it("never calls an unobserved AI provider healthy", async () => {
    window.history.replaceState({}, "", "/admin#overview");
    const data = overviewPayload({ system: { database: "up", redis: "up", publicationWorker: "up", ai: "unobserved" } });
    data.summary.failed = data.summary.quarantined = data.summary.overdue = data.summary.authAttention = 0;
    data.attention = []; data.providers = [];
    vi.stubGlobal("fetch", vi.fn(adminFetchMock({ "/api/admin/overview": () => data, "/api/admin/aurora-analytics": () => ({ problems: [] }) })));
    render(<AdminDashboard />);
    expect((await screen.findAllByText("Не все сервисы подтвердили работу")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Проверенные сервисы работают")).toBeNull();
  });
  it("marks an old snapshot stale and preserves its actual period", async () => {
    window.history.replaceState({}, "", "/admin#overview");
    vi.stubGlobal("fetch", vi.fn(adminFetchMock({ "/api/admin/overview": () => overviewPayload({ checkedAt: "2026-09-03T09:00:00Z" }), "/api/admin/aurora-analytics": () => ({ problems: [] }) })));
    render(<AdminDashboard />);
    expect(await screen.findByText("Состояние требует новой проверки")).toBeTruthy();
    expect(screen.getByText(/Данные устарели/u)).toBeTruthy();
  });
  it("clears cross-project information when a section reports an expired session", async () => {
    window.history.replaceState({}, "", "/admin#connections");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    render(<AdminDashboard />);
    expect(await screen.findByRole("heading", { name: "Сессия завершена" })).toBeTruthy();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });
  it("does not present a filtered empty list as confirmation that the queue works", async () => {
    window.history.replaceState({}, "", "/admin?pnetwork=tg#publications");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ checkedAt: new Date().toISOString(), summary: {}, items: [], pagination: { total: 0, page: 1, pages: 1 }, options: { networks: [], projects: [], errorCodes: [] } }), { status: 200 })));
    render(<AdminPublicationsCenter />);
    expect(await screen.findByText("По этим условиям публикаций нет")).toBeTruthy();
    expect(screen.queryByText("Очередь работает без просроченных и аварийных задач.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить фильтры" }));
    await waitFor(() => expect(window.location.search).toContain("pstatus=all"));
    expect(window.location.search).not.toContain("pnetwork");
  });
  it("does not report zero spend when monetary accounting is unavailable", async () => {
    window.history.replaceState({}, "", "/admin#ai");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ availability: "not_configured", checkedAt: new Date().toISOString(), periodDays: 7 }), { status: 200 })));
    render(<AdminAiSpendCenter period={7} refreshKey={0} />);
    expect(await screen.findByRole("heading", { name: "Учёт расходов не подключён" })).toBeTruthy();
    expect(screen.queryByText("0,00 $")).toBeNull();
    expect(screen.getByRole("link", { name: "Открыть использование AI в обзоре" }).getAttribute("href")).toBe("/admin#overview");
  });
  it("preserves microdollar precision instead of rounding a small charge to zero", () => {
    expect(usd("1")).toBe("0,000001 $");
    expect(usd("1290000")).toBe("1,29 $");
    expect(usd("0")).toBe("0,00 $");
  });
});
