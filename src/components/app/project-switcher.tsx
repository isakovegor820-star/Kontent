"use client";

import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ClientProject } from "@/lib/project-client";
import { cn } from "@/lib/utils";
import { useProjects } from "./project-provider";

const ROLE_LABEL: Record<ClientProject["role"], string> = {
  owner: "Владелец",
  author: "Автор",
  approver: "Согласующий",
  publisher: "Публикатор",
};

export function ProjectSwitcherView({
  projects,
  current,
  ready,
  error,
  switching,
  compact = false,
  onSelect,
  onRetry,
}: {
  projects: readonly ClientProject[];
  current: ClientProject | null;
  ready: boolean;
  error: boolean;
  switching: boolean;
  compact?: boolean;
  onSelect: (projectId: number) => void;
  onRetry: () => void;
}) {
  const labelId = compact ? "mobile-project-label" : "sidebar-project-label";
  if (!ready) {
    return compact ? (
      <div className="skeleton h-11 w-full max-w-48 rounded-xs" role="status">
        <span className="sr-only">Открываем проекты</span>
      </div>
    ) : (
      <div className="mx-3 mb-3 rounded-xs border border-line bg-surface/70 p-3" role="status">
        <span className="sr-only">Открываем проекты</span>
        <div className="skeleton h-3 w-16" />
        <div className="skeleton mt-2 h-5 w-36" />
      </div>
    );
  }

  if (error && projects.length === 0) {
    return compact ? (
      <Button type="button" variant="ghost" size="sm" onClick={onRetry} aria-label="Повторить загрузку проектов">
        <RefreshCw className="h-4 w-4" aria-hidden />
        Проекты
      </Button>
    ) : (
      <div className="mx-3 mb-3 rounded-xs border border-fire/30 bg-fire-soft p-3" role="alert">
        <p className="text-xs font-semibold text-fire-text">Проекты не загрузились</p>
        <Button type="button" variant="ghost" size="sm" className="mt-1" onClick={onRetry}>
          Повторить
        </Button>
      </div>
    );
  }

  return (
    <div className={cn(compact ? "min-w-0" : "mx-3 mb-3 border-b border-line px-1 pb-3")}>
      <label
        id={labelId}
        htmlFor={compact ? "mobile-project-switcher" : "sidebar-project-switcher"}
        className={compact ? "sr-only" : "mb-1.5 block px-1 text-[11px] font-bold tracking-[0.08em] text-text-3 uppercase"}
      >
        Текущий проект
      </label>
      <select
        id={compact ? "mobile-project-switcher" : "sidebar-project-switcher"}
        aria-labelledby={labelId}
        aria-busy={switching || undefined}
        value={current?.id ?? ""}
        disabled={switching || projects.length === 0}
        onChange={(event) => onSelect(Number(event.currentTarget.value))}
        className={cn(
          "h-11 min-w-0 rounded-xs border border-line bg-surface px-3 text-sm font-semibold text-text",
          "focus-visible:ring-4 focus-visible:ring-brand/15 disabled:opacity-60",
          compact ? "w-full max-w-52 truncate" : "w-full",
        )}
      >
        {projects.map((project) => (
          <option key={project.id} value={project.id}>{project.name}</option>
        ))}
      </select>
      {!compact && current ? (
        <p className="mt-1.5 truncate px-1 text-xs text-text-3">{ROLE_LABEL[current.role]}</p>
      ) : null}
      {!compact && error ? (
        <button type="button" onClick={onRetry} className="mt-1 min-h-11 px-1 text-xs font-semibold text-fire-text underline underline-offset-2">
          Обновить список
        </button>
      ) : null}
    </div>
  );
}

export function ProjectSwitcher({ compact = false }: { compact?: boolean }) {
  const state = useProjects();
  return (
    <ProjectSwitcherView
      projects={state.projects}
      current={state.current}
      ready={state.ready}
      error={state.error}
      switching={state.switching}
      compact={compact}
      onSelect={(projectId) => void state.selectProject(projectId)}
      onRetry={() => void state.refresh()}
    />
  );
}
