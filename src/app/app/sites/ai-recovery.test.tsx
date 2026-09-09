// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
vi.mock("@/components/app/shell", () => ({ AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
import SitesPage from "./page";
import { setClientProjectId } from "@/lib/project-fetch";
const site = { id: 5, confirmedDomain: "example.test", canonicalUrl: "https://example.test/", verification: { state: "unverified", instructions: { dns: {}, meta: {} } }, publishingMode: "confirm", approvedStreak: 0, autoUnlockStreak: 10, autoModeUnlocked: false, status: "active", latestProfileId: 77 };
const profile = { id: 77, pageCount: 1, publicationCount: 0, topics: [], gaps: [], technical: { seoScore: 80, geoScore: 70, seoIssues: [], geoIssues: [], pagesChecked: 1 }, linkablePages: [], summary: "Тестовый профиль", refinedAt: "2026-09-08T10:00Z", aiClassification: { status: "failed", topicClusters: 0 } };
const report = { id: 12, kind: "initial_audit", status: "ready", summaryRu: "Аудит", interpretation: null, interpretationStatus: "failed" };
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
afterEach(() => { cleanup(); setClientProjectId(null); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Sites AI recovery UI", () => {
  it("shows failure instead of a queue, retries the selected profile and updates its terminal status", async () => {
    setClientProjectId(7);
    vi.useFakeTimers();
    let state = { ...profile, refinedAt: null as string | null };
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/sites") return Response.json({ sites: [site] });
      if (url.endsWith("/destinations")) return Response.json({ destinations: [] });
      if (url.endsWith("/ai/retry")) {
        expect(JSON.parse(String(init?.body))).toEqual({ target: "profile" });
        state = { ...state, aiClassification: { status: "processing", topicClusters: 0 } };
        return Response.json({ ok: true }, { status: 202 });
      }
      return Response.json({ site, profile: state, reports: [report], latestAnalysis: null });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<SitesPage />); await flush(); await flush();
    expect(screen.getByText("уточнение не удалось")).toBeTruthy();
    expect(screen.queryByText(/уточнение моделью в очереди/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Повторить уточнение" })); await flush();
    expect(screen.getByText("уточняем профиль")).toBeTruthy();
    state = { ...state, refinedAt: "2026-09-08T11:00Z", aiClassification: { status: "ready", topicClusters: 0 } };
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByText("уточнён моделью")).toBeTruthy();
    const calls = fetcher.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(fetcher.mock.calls).toHaveLength(calls);
  });
  it("sends the report id and clears a failed network action so it can be retried", async () => {
    setClientProjectId(7);
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/sites") return Response.json({ sites: [site] });
      if (url.endsWith("/destinations")) return Response.json({ destinations: [] });
      if (url.endsWith("/ai/retry")) {
        expect(JSON.parse(String(init?.body))).toEqual({ target: "report", reportId: 12 });
        throw new TypeError("offline");
      }
      return Response.json({ site, profile, reports: [report], latestAnalysis: null });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<SitesPage />); await flush(); await flush();
    fireEvent.click(screen.getByRole("button", { name: "Повторить интерпретацию" })); await flush();
    expect((screen.getByRole("button", { name: "Повторить интерпретацию" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/Не получили подтверждение от сервера/)).toBeTruthy();
  });
  it("does not replace the selected site with an old report refresh timer", async () => {
    setClientProjectId(7);
    vi.useFakeTimers();
    const other = { ...site, id: 6, confirmedDomain: "other.example.test" };
    const fetcher = vi.fn(async (url: string) => {
      if (url === "/api/sites") return Response.json({ sites: [site, other] });
      if (url.endsWith("/destinations")) return Response.json({ destinations: [] });
      if (url.endsWith("/reports")) return Response.json({ ok: true }, { status: 202 });
      const second = url === "/api/sites/6";
      return Response.json({ site: second ? other : site, profile: { ...profile, summary: second ? "Профиль второго сайта" : "Профиль первого сайта" }, reports: [report], latestAnalysis: null });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<SitesPage />); await flush(); await flush();
    fireEvent.click(screen.getByRole("tab", { name: "Отчёты" }));
    fireEvent.click(screen.getByRole("button", { name: "Отчёт за 30 дней" })); await flush();
    fireEvent.click(screen.getByRole("button", { name: /other.example.test/ })); await flush();
    expect(screen.getByText("Профиль второго сайта")).toBeTruthy();
    const oldRequests = fetcher.mock.calls.filter(([url]) => url === "/api/sites/5").length;
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(screen.getByText("Профиль второго сайта")).toBeTruthy();
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/sites/5")).toHaveLength(oldRequests);
  });

});
