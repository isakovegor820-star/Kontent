"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LibraryRegistryDiagnostics, LibraryRegistryItem } from "@/lib/library-filters";

type Snapshot = {
  items: LibraryRegistryItem[];
  formulaVersion?: string;
  diagnostics?: LibraryRegistryDiagnostics;
};
type FeedState = Snapshot & {
  pending: LibraryRegistryItem[] | null;
  loading: boolean;
  refreshing: boolean;
  error: boolean;
  refreshError: boolean;
};

export const LIBRARY_REFRESH_INTERVAL = 60_000;

/** Poll the server without moving the material someone is reading. */
export function useLibraryFeed(query: string, mutationBusy: boolean) {
  const [feed, setFeed] = useState<FeedState>({
    items: [], pending: null, loading: true, refreshing: false, error: false, refreshError: false,
  });
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const busy = useRef(mutationBusy);
  const loaded = useRef(false);
  const localStates = useRef(new Map<string, Partial<LibraryRegistryItem>>());

  useEffect(() => { busy.current = mutationBusy; }, [mutationBusy]);

  const load = useCallback(async (mode: "initial" | "manual" | "background" = "manual") => {
    if (mode === "background" && (busy.current || controller.current || !loaded.current)) return;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const requestId = ++sequence.current;
    if (mode !== "background") setFeed((current) => ({
      ...current, loading: mode === "initial", refreshing: mode === "manual", refreshError: false,
    }));
    try {
      const response = await fetch(`/api/library/registry?${query}`, { cache: "no-store", signal: request.signal });
      const body = await response.json() as Snapshot & { ok?: boolean };
      if (!response.ok || !body.ok || !Array.isArray(body.items)) throw new Error("registry_failed");
      if (request.signal.aborted || requestId !== sequence.current) return;
      loaded.current = true;
      const nextItems = body.items.map((item) => ({ ...item, ...localStates.current.get(item.id) }));
      setFeed((current) => {
        const nextById = new Map(nextItems.map((item) => [item.id, item]));
        const currentIds = new Set(current.items.map((item) => item.id));
        const hasNew = nextItems.some((item) => !currentIds.has(item.id));
        const keepPosition = mode === "background" && current.items.length > 0;
        return {
          ...body,
          // Existing cards receive fresh metrics in place; new cards wait for an explicit click.
          items: keepPosition ? current.items.map((item) => nextById.get(item.id) ?? item) : nextItems,
          pending: keepPosition && hasNew ? nextItems : null,
          loading: false, refreshing: false, error: false, refreshError: false,
        };
      });
    } catch {
      if (request.signal.aborted || requestId !== sequence.current) return;
      setFeed((current) => ({
        ...current, loading: false, refreshing: false,
        error: !loaded.current, refreshError: loaded.current,
      }));
    } finally {
      if (controller.current === request) controller.current = null;
    }
  }, [query]);

  useEffect(() => {
    loaded.current = false;
    localStates.current.clear();
    const debounce = window.setTimeout(() => void load("initial"), 250);
    const check = () => {
      if (document.visibilityState === "visible") void load("background");
    };
    const interval = window.setInterval(check, LIBRARY_REFRESH_INTERVAL);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.clearTimeout(debounce);
      window.clearInterval(interval);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
      controller.current?.abort();
      controller.current = null;
      sequence.current += 1;
    };
  }, [load]);

  const patchItem = useCallback((id: string, patch: Partial<LibraryRegistryItem>) => {
    localStates.current.set(id, { ...localStates.current.get(id), ...patch });
    const apply = (item: LibraryRegistryItem) => item.id === id ? { ...item, ...patch } : item;
    setFeed((current) => ({ ...current, items: current.items.map(apply), pending: current.pending?.map(apply) ?? null }));
  }, []);

  const showNew = useCallback(() => {
    setFeed((current) => ({ ...current, items: current.pending ?? current.items, pending: null }));
  }, []);
  const visibleIds = new Set(feed.items.map((item) => item.id));
  const newCount = feed.pending?.filter((item) => !visibleIds.has(item.id)).length ?? 0;

  return { ...feed, newCount, refresh: load, showNew, patchItem };
}
