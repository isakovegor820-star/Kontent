import { isProjectHttpRequest, PROJECT_HEADER } from "./project-http-policy";

type Scope = { accountId: number | null; projectId: number | null; epoch: number; ready: boolean; controller: AbortController };
let scope: Scope = { accountId: null, projectId: null, epoch: 0, ready: false, controller: new AbortController() };
const listeners = new Set<() => void>();
export const subscribeProjectTransport = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const projectTransportSnapshot = () => scope;
export function setProjectTransport(projectId: number | null, ready = projectId != null, accountId = projectId == null ? null : scope.accountId) {
  if (scope.projectId === projectId && scope.ready === ready && scope.accountId === accountId) return;
  scope.controller.abort();
  scope = { accountId, projectId, ready, epoch: scope.epoch + 1, controller: new AbortController() };
  for (const listener of listeners) listener();
}
export function pauseProjectTransport() { setProjectTransport(scope.projectId, false); }
function assertCurrent(captured: Scope) {
  if (!captured.ready || captured.projectId == null || captured !== scope) {
    throw new DOMException("project_context_changed", "AbortError");
  }
}
export function projectUrl(input: string, projectId = scope.projectId): string {
  const url = new URL(input, typeof window === "undefined" ? "http://localhost" : window.location.origin);
  if (projectId != null) url.searchParams.set("projectId", String(projectId));
  return input.startsWith("/") ? `${url.pathname}${url.search}${url.hash}` : url.href;
}
export function captureProjectFetch(captured = scope): typeof fetch {
  return async (input, init) => {
    const base = typeof window === "undefined" ? "http://localhost" : window.location.origin;
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, base);
    const method = init?.method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET");
    if (url.origin !== base || !isProjectHttpRequest(url.pathname, method)) return globalThis.fetch(input, init);
    assertCurrent(captured);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const explicit = headers.get(PROJECT_HEADER) ?? url.searchParams.get("projectId");
    if (explicit != null && explicit !== String(captured.projectId)) throw new DOMException("project_context_mismatch", "AbortError");
    headers.set(PROJECT_HEADER, String(captured.projectId));
    const signals = [captured.controller.signal];
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : null);
    if (callerSignal) signals.push(callerSignal);
    const response = await globalThis.fetch(input, { ...init, headers, cache: "no-store", signal: AbortSignal.any(signals) });
    assertCurrent(captured);
    if (response.ok && response.headers.get(PROJECT_HEADER) !== String(captured.projectId)) {
      throw new DOMException("project_response_mismatch", "AbortError");
    }
    // Parsing can finish after a switch even if the HTTP response arrived before it.
    for (const method of ["json", "text", "blob", "arrayBuffer", "formData"] as const) {
      const read = response[method].bind(response);
      Object.defineProperty(response, method, { value: async () => {
        assertCurrent(captured);
        const value = await read();
        assertCurrent(captured);
        return value;
      } });
    }
    return response;
  };
}
/** For non-React client services. Capture once at entry for multi-request workflows. */
export const projectFetch: typeof fetch = (input, init) => captureProjectFetch()(input, init);
export function guardProjectCall<T extends (...args: never[]) => Promise<unknown>>(call: T, captured = scope): T {
  // Service callers attach .catch() in effects. A blocked request must remain an
  // asynchronous rejection instead of throwing through React's effect boundary.
  return (async (...args: Parameters<T>) => {
    assertCurrent(captured);
    const value = await call(...args);
    assertCurrent(captured);
    return value;
  }) as T;
}
