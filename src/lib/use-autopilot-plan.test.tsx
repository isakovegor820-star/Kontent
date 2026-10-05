// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setProjectTransport } from "./project-transport";
import { useAutopilotPlan } from "./use-autopilot-plan";

const item = (planId: number, index: number) => ({
  key: `plan-${planId}-${index}`,
  id: `plan-${planId}-${index}`,
  planId,
  planRevision: 3,
  planStatus: "pending",
  index,
  channelId: 7,
  channelTitle: "Канал",
  scheduledAt: "2026-10-08T14:00:00.000Z",
  topic: "Тема",
  text: "Текст",
  media: null,
  formatting: [],
  state: "ready",
  statusLabel: "Не подтверждён",
  issues: [],
  selectable: true,
  editable: true,
});

let failing = false;
let truncated = false;
function reply(input: RequestInfo | URL, init?: RequestInit) {
  const project = Number(new Headers(init?.headers).get("x-aurora-project-id"));
  if (failing) return new Response(null, { status: 503 });
  expect(String(input)).toContain("/api/autopilot/calendar-plan");
  return new Response(JSON.stringify({ ok: true, items: [item(project * 10, 0)], truncated }), {
    headers: { "x-aurora-project-id": String(project) },
  });
}

beforeEach(() => {
  failing = false;
  truncated = false;
  setProjectTransport(7, true, 1);
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(reply(input, init))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("autopilot plan in the main calendar", () => {
  it("загружает неподтверждённый план выбранного проекта", async () => {
    const { result } = renderHook(() => useAutopilotPlan(7, 0));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.items.map((entry) => entry.key)).toEqual(["plan-70-0"]);
    expect(result.current.error).toBe(false);
  });

  it("не показывает чужой план при смене проекта", async () => {
    const { result, rerender } = renderHook(({ project }) => useAutopilotPlan(project, 0), { initialProps: { project: 7 } });
    await waitFor(() => expect(result.current.items.map((entry) => entry.planId)).toEqual([70]));
    setProjectTransport(8, true, 2);
    rerender({ project: 8 });
    expect(result.current.items).toEqual([]);
    await waitFor(() => expect(result.current.items.map((entry) => entry.planId)).toEqual([80]));
  });

  it("не выдаёт сбой плана за пустой календарь", async () => {
    failing = true;
    const { result } = renderHook(() => useAutopilotPlan(7, 0));
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.ready).toBe(true);
    expect(result.current.items).toEqual([]);
    failing = false;
    await waitFor(async () => {
      await result.current.refresh();
      expect(result.current.error).toBe(false);
    });
    expect(result.current.items).toHaveLength(1);
  });

  it("сообщает, что план показан не полностью", async () => {
    truncated = true;
    const { result } = renderHook(() => useAutopilotPlan(7, 0));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.truncated).toBe(true);
  });

  it("перезапрашивает план после изменения публикаций", async () => {
    const { result, rerender } = renderHook(({ revision }) => useAutopilotPlan(7, revision), { initialProps: { revision: 0 } });
    await waitFor(() => expect(result.current.ready).toBe(true));
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    rerender({ revision: 1 });
    await waitFor(() => {
      expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(calls);
    });
  });
});
