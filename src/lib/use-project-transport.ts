"use client";
import { useMemo, useSyncExternalStore } from "react";
import { captureProjectFetch, guardProjectCall, projectTransportSnapshot, subscribeProjectTransport } from "./project-transport";

export function useProjectFetch(): typeof fetch {
  const scope = useSyncExternalStore(subscribeProjectTransport, projectTransportSnapshot, projectTransportSnapshot);
  return useMemo(() => captureProjectFetch(scope), [scope]);
}
/** Also stops an old screen from starting a service call after an awaited UI action. */
export function useProjectCall<T extends (...args: never[]) => Promise<unknown>>(call: T): T {
  const scope = useSyncExternalStore(subscribeProjectTransport, projectTransportSnapshot, projectTransportSnapshot);
  return useMemo(() => guardProjectCall(call, scope), [call, scope]);
}

export function useProjectStorageKey(base: string): string {
  const scope = useSyncExternalStore(subscribeProjectTransport, projectTransportSnapshot, projectTransportSnapshot);
  return `${base}:user-${scope.accountId ?? "guest"}:project-${scope.projectId ?? "none"}`;
}
