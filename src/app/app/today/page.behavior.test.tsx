// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import TodayPage from "./page";
import type { TodayBoard, TodayItem } from "@/lib/today";

const mocked = vi.hoisted(() => {
  const replace = vi.fn(); const push = vi.fn();
  return { request: vi.fn(), replace, push, router: { replace, push }, search: new URLSearchParams("channel=1") };
});
vi.mock("@/lib/project-fetch", () => ({ projectFetch: mocked.request }));
vi.mock("@/components/app/shell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock("@/components/app/evidence-card", () => ({ EvidenceCard: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => mocked.router, usePathname: () => "/app/today", useSearchParams: () => mocked.search }));

const item: TodayItem = { fingerprint: "own-decision", type: "risk", title: "Синтетическое решение", whyNow: "Нужно проверить собственный материал", channelId: 1, channelLabel: "Первый канал", confidence: "high", epistemicState: "observed", freshness: "Сегодня", priority: 10, primaryAction: { label: "Открыть материал", href: "/app/calendar" }, secondaryAction: null, evidence: null, sourceLabel: "Черновики", smartAction: null, recommendationKind: "calendar_gap" };
function board(): TodayBoard {
  return { enabled: true, projectId: 10, timezone: "Europe/Amsterdam", channelId: 1, channelLabel: "Первый канал", channels: [{ id: 1, label: "Первый канал", enabled: true }, { id: 2, label: "Второй канал", enabled: true }], updatedAt: "2026-09-06T00:00:00.000Z", lastSuccessfulAt: null, availability: "ready", items: [{ ...item }], completedItems: [], partialErrors: [], sourceStatuses: [], readiness: { state: "has_items", competitorCount: 2, opportunityCount: 1, publishedCount: 1, statsCount: 1 }, summary: { doneToday: 0, snoozed: 0 }, pulse: { state: "no_posts", periodLabel: "Последние 7 дней", publishedCount: 0, postsWithStats: 0, views: 0, reactions: 0, engagementRate: null, comparison: { viewsPerPostPercent: null, reactionsPerPostPercent: null, engagementPoints: null }, bestPost: null, latestPost: null, series: [], insight: "", collectedAt: null } };
}

type Pending = { signal: AbortSignal; resolve: (response: Response) => void; body: Record<string, unknown> };
function fixture(initial = board()) {
  const pending: Pending[] = []; let stored = initial;
  mocked.request.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method !== "POST") return Promise.resolve(Response.json(stored));
    return new Promise<Response>((resolve, reject) => {
      const signal = init.signal as AbortSignal;
      signal.addEventListener("abort", () => reject(new DOMException("Caller cancelled", "AbortError")), { once: true });
      pending.push({ signal, resolve, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    });
  });
  return { pending, stored: (next: TodayBoard) => { stored = next; } };
}
async function start(label: string) {
  render(<TodayPage />);
  await screen.findByRole("heading", { name: item.title });
  if (label !== "Готово") fireEvent.click(screen.getByLabelText("Дополнительные действия"));
  fireEvent.click(screen.getByRole("button", { name: label }));
}
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it("does not cancel a pending snooze when channel selection is attempted", async () => {
  const f = fixture(); await start("Напомнить завтра"); await waitFor(() => expect(f.pending).toHaveLength(1));
  const selector = screen.getByRole("combobox", { name: "Канал" }) as HTMLSelectElement;
  fireEvent.change(selector, { target: { value: "2" } });
  expect(f.pending[0].signal.aborted).toBe(false);
  expect(mocked.replace).not.toHaveBeenCalled(); expect(selector.disabled).toBe(true);
});

it.each(["Готово", "Напомнить завтра", "Отклонить", "Больше не показывать такое"])("does not report confirmed success before %s is acknowledged", async label => {
  const f = fixture(); await start(label); await waitFor(() => expect(f.pending).toHaveLength(1));
  expect(screen.queryByText("Решение отмечено готовым")).toBeNull();
  expect(screen.queryByText("Напомним завтра в 09:00")).toBeNull();
  expect(screen.queryByText("Решение отклонено")).toBeNull();
  expect(screen.queryByText("Тип рекомендаций скрыт")).toBeNull();
  expect(screen.queryByRole("heading", { name: "Готовые сегодня" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "На сегодня всё выполнено" })).toBeNull();
  expect(screen.getAllByText(/Сохраняем/u).length).toBeGreaterThan(0);
});

it("waits for the complete positive state receipt, not only response headers", async () => {
  const f = fixture(); await start("Напомнить завтра"); await waitFor(() => expect(f.pending).toHaveLength(1));
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }), { status: 200, headers: { "content-type": "application/json" } });
  await act(async () => { f.pending[0].resolve(response); });
  expect((screen.getByRole("combobox", { name: "Канал" }) as HTMLSelectElement).disabled).toBe(true);
  expect(screen.queryByText("Напомним завтра в 09:00")).toBeNull();
  const next = board(); next.items = []; next.summary.snoozed = 1; f.stored(next);
  await act(async () => { body.enqueue(new TextEncoder().encode('{"ok":true}')); body.close(); });
  expect(await screen.findByText("Напомним завтра в 09:00")).toBeTruthy();
  await waitFor(() => expect((screen.getByRole("combobox", { name: "Канал" }) as HTMLSelectElement).disabled).toBe(false));
});

it("restores the decision on a failed state response", async () => {
  const f = fixture(); await start("Напомнить завтра"); await waitFor(() => expect(f.pending).toHaveLength(1));
  await act(async () => { f.pending[0].resolve(Response.json({ error: "state_unavailable" }, { status: 503 })); });
  expect(await screen.findByRole("heading", { name: item.title })).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("Карточка возвращена");
  expect(screen.queryByText("Напомним завтра в 09:00")).toBeNull();
});

it("allows explicit channel selection while no mutation is pending", async () => {
  fixture(); render(<TodayPage />); await screen.findByRole("heading", { name: item.title });
  fireEvent.change(screen.getByRole("combobox", { name: "Канал" }), { target: { value: "2" } });
  expect(mocked.replace).toHaveBeenCalledWith("/app/today?channel=2", { scroll: false });
});

it.each(["Готово", "Больше не показывать такое"])("does not count a pending %s as a completed quick decision", async label => {
  const initial = board(); initial.items.push({ ...item, fingerprint: "second-decision", title: "Второе решение" });
  const f = fixture(initial); render(<TodayPage />); await screen.findByRole("heading", { name: item.title });
  fireEvent.click(screen.getByRole("button", { name: "Разобрать за 5 минут" }));
  if (label === "Готово") {
    fireEvent.click(screen.getByRole("button", { name: label }));
    await waitFor(() => expect(f.pending).toHaveLength(1));
    const next = { ...initial, items: [initial.items[1]] }; f.stored(next);
    await act(async () => { f.pending[0].resolve(Response.json({ ok: true })); });
    await waitFor(() => expect((screen.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(false));
  }
  if (label !== "Готово") fireEvent.click(screen.getByLabelText("Дополнительные действия"));
  fireEvent.click(screen.getByRole("button", { name: label }));
  await waitFor(() => expect(f.pending).toHaveLength(label === "Готово" ? 2 : 1));
  expect(screen.getByText(label === "Готово" ? "Разобрано: 1 из 2." : "Разобрано: 0 из 2.")).toBeTruthy();
  const pendingCard = screen.getByRole("heading", { name: "Сохраняем последнее решение…" }).closest('[role="status"]');
  expect(pendingCard?.querySelector(".text-success-text")).toBeNull();
  expect(screen.queryByRole("heading", { name: "Быстрый разбор завершён" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Вернуться к сводке" }));
  expect(document.querySelector('[aria-live="polite"]')?.textContent).not.toContain("завершён");
  expect(f.pending.at(-1)?.signal.aborted).toBe(false);
});

it.each(["Готово", "Больше не показывать такое"])("rejects an incomplete positive receipt for %s", async label => {
  const f = fixture(); await start(label); await waitFor(() => expect(f.pending).toHaveLength(1));
  await act(async () => { f.pending[0].resolve(Response.json({ ok: false })); });
  expect(await screen.findByRole("heading", { name: item.title })).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("Карточка возвращена");
  expect(screen.queryByText("Решение отмечено готовым")).toBeNull();
  expect(screen.queryByText("Тип рекомендаций скрыт")).toBeNull();
});

it.each(["Напомнить завтра", "Больше не показывать такое"])("keeps channel ownership until a complete undo receipt for %s", async label => {
  const f = fixture(); await start(label); await waitFor(() => expect(f.pending).toHaveLength(1));
  const next = board(); next.items = []; f.stored(next);
  await act(async () => { f.pending[0].resolve(Response.json({ ok: true })); });
  const undo = await screen.findByRole("button", { name: "Вернуть" });
  await waitFor(() => expect((undo as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(undo);
  await waitFor(() => expect(f.pending).toHaveLength(2));
  let body!: ReadableStreamDefaultController<Uint8Array>;
  await act(async () => { f.pending[1].resolve(new Response(new ReadableStream<Uint8Array>({ start(c) { body = c; } }), { status: 200 })); });
  const selector = screen.getByRole("combobox", { name: "Канал" }) as HTMLSelectElement;
  fireEvent.change(selector, { target: { value: "2" } });
  expect(selector.disabled).toBe(true); expect(f.pending[1].signal.aborted).toBe(false);
  expect(mocked.replace).not.toHaveBeenCalled(); expect(screen.getByText("Возвращаем решение…")).toBeTruthy();
  f.stored(board()); await act(async () => { body.enqueue(new TextEncoder().encode('{"ok":true}')); body.close(); });
  expect(await screen.findByRole("heading", { name: item.title })).toBeTruthy();
  await waitFor(() => expect(selector.disabled).toBe(false));
});
