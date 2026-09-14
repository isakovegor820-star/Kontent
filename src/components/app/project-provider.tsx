"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { parseClientProject, parseProjectsResponse, parseSelectedProjectResponse, type ClientProject } from "@/lib/project-client";
import { pauseProjectTransport, setProjectTransport } from "@/lib/project-transport";
import { useStore } from "@/lib/store";

type ProjectContextValue = {
  projects: ClientProject[];
  current: ClientProject | null;
  ready: boolean;
  error: boolean;
  switching: boolean;
  refresh: () => Promise<void>;
  selectProject: (projectId: number) => Promise<boolean>;
  createProject: (input: { name: string; timezone: string }) => Promise<{ ok: boolean; error?: string }>;
};
const ProjectContext = createContext<ProjectContextValue | null>(null);
export function useProjects() {
  const value = useContext(ProjectContext);
  if (!value) throw new Error("useProjects должен вызываться внутри ProjectProvider");
  return value;
}
const contextRequest = (input: string, init?: RequestInit) => fetch(input, {
  ...init, cache: "no-store", signal: AbortSignal.timeout(15_000),
});

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const { user, authReady, toast } = useStore();
  const [projects, setProjects] = useState<ClientProject[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [unresolved, setUnresolved] = useState(false);
  const requestSequence = useRef(0);
  const mutationRunning = useRef(false);
  const selectedId = useRef<number | null>(null);
  const accountEpoch = useRef(0);

  const applySelection = useCallback((list: ClientProject[], selected: ClientProject) => {
    const byId = new Map(list.map((project) => [project.id, project]));
    byId.set(selected.id, { ...byId.get(selected.id), ...selected,
      createdAt: selected.createdAt || byId.get(selected.id)?.createdAt || "" });
    setProjects([...byId.values()].map((project) => ({ ...project, selected: project.id === selected.id })));
    const changed = selectedId.current !== selected.id;
    selectedId.current = selected.id;
    setProjectTransport(selected.id, true, user?.id ?? null);
    setError(false);
    setUnresolved(false);
    setReady(true);
    if (changed) window.dispatchEvent(new CustomEvent("aurora:project-changed", { detail: { projectId: selected.id } }));
  }, [user?.id]);

  const reconcile = useCallback(async (): Promise<ClientProject | null> => {
    const sequence = ++requestSequence.current;
    try {
      const [listResponse, currentResponse] = await Promise.all([
        contextRequest("/api/projects"), contextRequest("/api/projects/current"),
      ]);
      const [listBody, currentBody] = await Promise.all([listResponse.json(), currentResponse.json()]);
      const list = listResponse.ok ? parseProjectsResponse(listBody) : null;
      const selected = currentResponse.ok ? parseSelectedProjectResponse(currentBody) : null;
      if (!list || !selected) throw new Error("projects_unavailable");
      if (sequence !== requestSequence.current) return null;
      applySelection(list, selected);
      return selected;
    } catch {
      if (sequence !== requestSequence.current) return null;
      pauseProjectTransport();
      setError(true);
      setUnresolved(true);
      return null;
    } finally {
      if (sequence === requestSequence.current) setReady(true);
    }
  }, [applySelection]);
  const refresh = useCallback(async () => { await reconcile(); }, [reconcile]);

  const userId = user?.id ?? null;
  useEffect(() => {
    setProjectTransport(null);
    const epoch = ++accountEpoch.current;
    requestSequence.current += 1;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || epoch !== accountEpoch.current) return;
      selectedId.current = null;
      mutationRunning.current = false;
      setProjects([]);
      setSwitching(false);
      setError(false);
      setUnresolved(false);
      setReady(authReady && userId == null);
      if (authReady && userId != null) void reconcile();
    });
    return () => { cancelled = true; requestSequence.current += 1; };
  }, [authReady, userId, reconcile]);

  const selectProject = useCallback(async (projectId: number) => {
    if (mutationRunning.current || unresolved || !projects.some((project) => project.id === projectId)) return false;
    mutationRunning.current = true;
    pauseProjectTransport();
    requestSequence.current += 1;
    const epoch = accountEpoch.current;
    setSwitching(true);
    setUnresolved(true);
    try {
      const response = await contextRequest("/api/projects/current", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId }),
      });
      const selected = response.ok ? parseSelectedProjectResponse(await response.json()) : null;
      if (!selected || selected.id !== projectId) throw new Error("project_switch_failed");
      if (epoch !== accountEpoch.current) return false;
      applySelection(projects, selected);
      return true;
    } catch {
      // The server may already have committed. Keep the old screen inert until the
      // authoritative context is readable, even when the original response is lost.
      if (epoch !== accountEpoch.current) return false;
      return (await reconcile())?.id === projectId;
    } finally {
      if (epoch === accountEpoch.current) { mutationRunning.current = false; setSwitching(false); }
    }
  }, [projects, unresolved, applySelection, reconcile]);

  const createProject = useCallback(async (input: { name: string; timezone: string }) => {
    if (mutationRunning.current || unresolved) return { ok: false, error: "project_context_unavailable" };
    mutationRunning.current = true;
    pauseProjectTransport();
    requestSequence.current += 1;
    const epoch = accountEpoch.current;
    setSwitching(true);
    setUnresolved(true);
    try {
      const response = await contextRequest("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(input),
      });
      const body = await response.json() as { ok?: unknown; project?: unknown; error?: string };
      const created = response.ok && body.ok === true ? parseClientProject(body.project) : null;
      if (epoch !== accountEpoch.current) return { ok: false, error: "project_context_changed" };
      if (!created) {
        await reconcile();
        return { ok: false, error: body.error ?? "server" };
      }
      // Creation replays can refer to a project which is no longer selected. Read the
      // actual selection rather than forcing the returned project into the UI.
      if (!await reconcile()) return { ok: false, error: "project_context_unavailable" };
      toast({ kind: "success", title: `Проект «${created.name}» создан.` });
      return { ok: true };
    } catch {
      if (epoch === accountEpoch.current) await reconcile();
      return { ok: false, error: "network" };
    } finally {
      if (epoch === accountEpoch.current) { mutationRunning.current = false; setSwitching(false); }
    }
  }, [unresolved, reconcile, toast]);

  const current = projects.find((project) => project.selected) ?? null;
  const value = useMemo<ProjectContextValue>(() => ({
    projects, current, ready, error, switching, refresh, selectProject, createProject,
  }), [projects, current, ready, error, switching, refresh, selectProject, createProject]);
  const blocked = userId != null && (!ready || switching || unresolved);
  return <ProjectContext.Provider value={value}>
    <div className="contents" inert={blocked || undefined} aria-busy={blocked || undefined} key={current?.id ?? "initial"}>
      {children}
    </div>
    {blocked ? <div role="status" aria-live="polite" className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-6">
      <div className="max-w-md rounded-2xl bg-[var(--bg)] p-6 text-[var(--text)] shadow-xl">
        <p>{switching ? "Переключаем проект…" : "Не удалось проверить текущий проект. Обновите его, чтобы продолжить работу."}</p>
        {!switching ? <button type="button" className="mt-4 rounded-lg border px-4 py-2" onClick={() => void refresh()}>Обновить проект</button> : null}
      </div>
    </div> : null}
  </ProjectContext.Provider>;
}
