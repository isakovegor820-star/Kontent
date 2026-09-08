"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { collectCalendarPages, mergeCalendarRecords } from "./calendar-pages";
import type { CalendarSelection } from "./calendar-query";
import type { ServerDraft } from "./draft-types";
import type { RealPost } from "./types";
import { projectTransportSnapshot, subscribeProjectTransport } from "./project-transport";
import { useProjectFetch } from "./use-project-transport";

type Data = { key: string; posts: RealPost[]; drafts: ServerDraft[]; ready: boolean; error: boolean };
const EMPTY_POSTS: RealPost[] = [];
const EMPTY_DRAFTS: ServerDraft[] = [];

export function useCalendarData(projectId: number | undefined, timezone: string, from: string, to: string, revision: unknown) {
  const fetcher = useProjectFetch();
  const transport = useSyncExternalStore(subscribeProjectTransport, projectTransportSnapshot, projectTransportSnapshot);
  const key = `${transport.epoch}:${projectId}:${timezone}:${from}:${to}`;
  const [data, setData] = useState<Data | null>(null);
  const active = useRef<{ controller: AbortController; sequence: number } | null>(null);
  const refresh = useCallback(async () => {
    if (!projectId) return;
    active.current?.controller.abort();
    const ticket = { controller: new AbortController(), sequence: (active.current?.sequence ?? 0) + 1 };
    active.current = ticket;
    const current = () => active.current === ticket && !ticket.controller.signal.aborted;
    const selections: CalendarSelection[] = [{ view: "range", from, to, timezone }, { view: "undated" }, { view: "attention" }];
    try {
      const results = await Promise.all(selections.map(async selection => {
        const options = { selection, fetcher, signal: ticket.controller.signal };
        const [posts, drafts] = await Promise.all([
          collectCalendarPages<RealPost>("/api/posts", options),
          collectCalendarPages<ServerDraft>("/api/drafts", options),
        ]);
        return { posts, drafts };
      }));
      if (current()) setData({ key, posts: mergeCalendarRecords(...results.map(r => r.posts)), drafts: mergeCalendarRecords(...results.map(r => r.drafts)), ready: true, error: false });
    } catch (error) {
      if (!current() || (error instanceof DOMException && error.name === "AbortError")) return;
      ticket.controller.abort();
      setData(previous => ({ key, posts: previous?.key === key ? previous.posts : [], drafts: previous?.key === key ? previous.drafts : [], ready: true, error: true }));
    }
  }, [fetcher, from, key, projectId, timezone, to]);
  useEffect(() => {
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => { active.current?.controller.abort(); window.removeEventListener("focus", onFocus); };
  }, [refresh, revision]);
  const visible = data?.key === key ? data : null;
  const updateDraft = useCallback((draft: ServerDraft) => {
    setData(previous => previous?.key === key ? { ...previous, drafts: previous.drafts.map(item => item.id === draft.id ? draft : item) } : previous);
  }, [key]);
  return { posts: visible?.posts ?? EMPTY_POSTS, drafts: visible?.drafts ?? EMPTY_DRAFTS, ready: visible?.ready ?? false, error: visible?.error ?? false, refresh, updateDraft };
}
