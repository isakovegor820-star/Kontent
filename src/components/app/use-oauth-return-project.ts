"use client";

import { useEffect, useRef, useState } from "react";
import { useProjects } from "./project-provider";

/** A success notice and subsequent reads must refer to the project that began OAuth. */
export function useOAuthReturnProject(active: boolean, rawProjectId: string | null): "ready" | "pending" | "forbidden" {
  const { current, ready, switching, selectProject } = useProjects();
  const projectId = rawProjectId && /^[1-9]\d*$/u.test(rawProjectId) && Number.isSafeInteger(Number(rawProjectId))
    ? Number(rawProjectId) : null;
  const attempted = useRef<number | null>(null);
  const mounted = useRef(true);
  const [failed, setFailed] = useState<number | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!active || !ready || switching || projectId === null || current?.id === projectId || attempted.current === projectId) return;
    attempted.current = projectId;
    void selectProject(projectId).then((selected) => {
      if (!selected && mounted.current) setFailed(projectId);
    }).catch(() => { if (mounted.current) setFailed(projectId); });
  }, [active, ready, switching, projectId, current?.id, selectProject]);
  if (!active) return "ready";
  if (projectId === null || failed === projectId) return "forbidden";
  return ready && current?.id === projectId ? "ready" : "pending";
}
