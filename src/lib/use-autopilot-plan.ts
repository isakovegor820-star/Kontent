"use client";
// План автопилота для основного календаря: те же отмена/повтор, что у данных календаря,
// чтобы смена проекта или устаревший ответ не подмешивали чужой план.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AutopilotCalendarPlanItem } from "./autopilot-calendar-plan.mjs";
import { projectTransportSnapshot, subscribeProjectTransport } from "./project-transport";
import { useProjectFetch } from "./use-project-transport";

export type { AutopilotCalendarPlanItem };

type Data = { key: string; items: AutopilotCalendarPlanItem[]; truncated: boolean; ready: boolean; error: boolean };
const EMPTY: AutopilotCalendarPlanItem[] = [];

export function useAutopilotPlan(projectId: number | undefined, revision: unknown) {
  const fetcher = useProjectFetch();
  const transport = useSyncExternalStore(subscribeProjectTransport, projectTransportSnapshot, projectTransportSnapshot);
  const key = `${transport.epoch}:${projectId}`;
  const [data, setData] = useState<Data | null>(null);
  const active = useRef<{ controller: AbortController; sequence: number; key: string } | null>(null);
  const refresh = useCallback(async () => {
    if (!projectId) return;
    active.current?.controller.abort();
    const ticket = { controller: new AbortController(), sequence: (active.current?.sequence ?? 0) + 1, key };
    active.current = ticket;
    const current = () => active.current === ticket && !ticket.controller.signal.aborted;
    try {
      const response = await fetcher("/api/autopilot/calendar-plan", {
        signal: ticket.controller.signal,
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error("autopilot_plan_unavailable");
      const body = (await response.json()) as {
        ok?: boolean;
        items?: AutopilotCalendarPlanItem[];
        truncated?: boolean;
      };
      if (!current()) return;
      // План — вспомогательный слой: его сбой не должен выглядеть как пустой календарь,
      // поэтому ошибка живёт отдельным флагом, а не подменяет публикации.
      setData({
        key,
        items: body.ok === true ? (body.items ?? []) : [],
        truncated: body.ok === true && body.truncated === true,
        ready: true,
        error: body.ok !== true,
      });
    } catch (error) {
      if (!current() || (error instanceof DOMException && error.name === "AbortError")) return;
      ticket.controller.abort();
      setData((previous) => ({
        key,
        items: previous?.key === key ? previous.items : [],
        truncated: previous?.key === key ? previous.truncated : false,
        ready: true,
        error: true,
      }));
    }
  }, [fetcher, key, projectId]);
  useEffect(() => {
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => { active.current?.controller.abort(); window.removeEventListener("focus", onFocus); };
  }, [refresh, revision]);
  const visible = data?.key === key ? data : null;
  return {
    items: visible?.items ?? EMPTY,
    truncated: visible?.truncated ?? false,
    ready: visible?.ready ?? false,
    error: visible?.error ?? false,
    refresh,
  };
}
