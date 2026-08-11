"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  parseClientProject,
  parseProjectsResponse,
  type ClientProject,
} from "@/lib/project-client";
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

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const { user, authReady } = useStore();
  const [projects, setProjects] = useState<ClientProject[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [switching, setSwitching] = useState(false);
  const requestSequence = useRef(0);

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    try {
      const response = await fetch("/api/projects", { cache: "no-store" });
      const body = await response.json().catch(() => null);
      const parsed = response.ok ? parseProjectsResponse(body) : null;
      if (!parsed) throw new Error("projects_unavailable");
      if (sequence !== requestSequence.current) return;
      setProjects(parsed);
      setError(false);
    } catch {
      if (sequence !== requestSequence.current) return;
      setError(true);
    } finally {
      if (sequence === requestSequence.current) setReady(true);
    }
  }, []);

  const userId = user?.id ?? null;
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      requestSequence.current += 1;
      if (!authReady || userId == null) {
        setProjects([]);
        setReady(authReady);
        setError(false);
        return;
      }
      setReady(false);
      void refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [authReady, userId, refresh]);

  const selectProject = useCallback(async (projectId: number) => {
    if (switching || !projects.some((project) => project.id === projectId)) return false;
    setSwitching(true);
    try {
      const response = await fetch("/api/projects/current", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const body = await response.json().catch(() => null) as Record<string, unknown> | null;
      const selected = response.ok && body && body.ok === true ? parseClientProject(body.project) : null;
      if (!selected) throw new Error("project_switch_failed");
      setProjects((current) => current.map((project) => ({
        ...project,
        selected: project.id === selected.id,
      })));
      setError(false);
      window.dispatchEvent(new CustomEvent("aurora:project-changed", { detail: { projectId: selected.id } }));
      return true;
    } catch {
      setError(true);
      return false;
    } finally {
      setSwitching(false);
    }
  }, [projects, switching]);

  const createProject = useCallback(async (input: { name: string; timezone: string }) => {
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) return { ok: false, error: body?.error ?? "server" };
      await refresh();
      window.dispatchEvent(new CustomEvent("aurora:project-changed"));
      return { ok: true };
    } catch {
      return { ok: false, error: "network" };
    }
  }, [refresh]);

  const current = projects.find((project) => project.selected) ?? null;
  const value = useMemo<ProjectContextValue>(() => ({
    projects,
    current,
    ready,
    error,
    switching,
    refresh,
    selectProject,
    createProject,
  }), [projects, current, ready, error, switching, refresh, selectProject, createProject]);

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}
