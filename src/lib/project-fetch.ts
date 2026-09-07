/** A tab owns its workspace. Never infer an outgoing request's project from another tab. */
const STORAGE_KEY = "aurora:request-project-id";
const USER_STORAGE_KEY = "aurora:request-project-user-id";
const HEADER = "x-aurora-project-id";
let activeProjectId: number | null = null;
let projectUserId: number | null = null;
type ProjectBinding = { projectId: number; generation: number };
let bootstrap: Promise<ProjectBinding> | null = null;
let generation = 0;

function validId(value: unknown): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function getClientProjectId(): number | null {
  if (activeProjectId !== null || typeof window === "undefined") return activeProjectId;
  try { activeProjectId = validId(window.sessionStorage.getItem(STORAGE_KEY)); } catch { /* memory still works */ }
  return activeProjectId;
}

export function setClientProjectId(projectId: number | null): void {
  const next = validId(projectId);
  if (next === null || getClientProjectId() !== next) generation += 1;
  activeProjectId = next;
  if (typeof window !== "undefined") {
    try {
      if (next === null) window.sessionStorage.removeItem(STORAGE_KEY);
      else window.sessionStorage.setItem(STORAGE_KEY, String(next));
    } catch { /* restricted browser storage must not change the request binding */ }
  }
}

/** Bind restored tab state only after the server confirms the account identity. */
export function setClientProjectUser(userId: number | null): void {
  const next = validId(userId);
  if (typeof window !== "undefined") {
    try { projectUserId = validId(window.sessionStorage.getItem(USER_STORAGE_KEY)); } catch { /* use memory */ }
  }
  if (next === null || projectUserId !== next) {
    setClientProjectId(null);
    bootstrap = null;
  }
  projectUserId = next;
  if (typeof window !== "undefined") {
    try {
      if (next === null) window.sessionStorage.removeItem(USER_STORAGE_KEY);
      else window.sessionStorage.setItem(USER_STORAGE_KEY, String(next));
    } catch { /* memory keeps the authenticated account binding */ }
  }
}

function changed(): never { throw new DOMException("Workspace changed during request", "AbortError"); }

async function ensureProject(): Promise<ProjectBinding> {
  const known = getClientProjectId();
  if (known !== null) return { projectId: known, generation };
  if (!bootstrap) {
    const initialGeneration = generation;
    const pending: Promise<ProjectBinding> = (async () => {
      const response = await globalThis.fetch("/api/projects/current", { cache: "no-store", signal: AbortSignal.timeout(8_000) });
      const body = await response.json();
      const id = response.ok ? validId(body?.project?.projectId ?? body?.project?.id) : null;
      if (id === null) throw new Error("project_context_unavailable");
      if (generation !== initialGeneration) changed();
      setClientProjectId(id);
      return { projectId: id, generation };
    })().finally(() => { if (bootstrap === pending) bootstrap = null; });
    bootstrap = pending;
  }
  return bootstrap;
}

export const projectFetch: typeof fetch = async (input, init) => {
  if (typeof window === "undefined") return globalThis.fetch(input, init);
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
  const scoped = url.origin === window.location.origin && url.pathname.startsWith("/api/")
    && !/^\/api\/(?:auth(?:\/|$)|lead$|health(?:\/|$)|ready(?:\/|$)|admin(?:\/|$)|tracking\/(?:ping|conversions|client\.js)$)/u.test(url.pathname);
  if (!scoped) return globalThis.fetch(input, init);
  const { projectId, generation: requestGeneration } = await ensureProject();
  if (requestGeneration !== generation || getClientProjectId() !== projectId) changed();
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  const explicit = headers.get(HEADER);
  if (explicit !== null && validId(explicit) !== projectId) changed();
  headers.set(HEADER, String(projectId));
  if (init?.signal?.aborted) changed();
  const response = await globalThis.fetch(input, { ...init, headers });
  if (requestGeneration !== generation || getClientProjectId() !== projectId) changed();
  return guardProjectResponse(response, () => requestGeneration === generation && getClientProjectId() === projectId);
};

/** Guard body consumers without feeding an errored synthetic stream to native
 * Response.json/text. Firefox reports those caught failures as console errors and
 * can change a network TypeError into AbortError. Preserve the original failure. */
function guardProjectResponse(response: Response, current: () => boolean): Response {
  let guardedBody: ReadableStream<Uint8Array> | null | undefined;
  let consumed = false;
  const check = () => { if (!current()) changed(); };
  const body = () => {
    if (guardedBody !== undefined) return guardedBody;
    const source = response.body;
    if (!source) return (guardedBody = null);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    guardedBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          check();
          reader ??= source.getReader();
          const chunk = await reader.read();
          if (!current()) { await reader.cancel().catch(() => {}); changed(); }
          if (chunk.done) { reader.releaseLock(); controller.close(); }
          else controller.enqueue(chunk.value);
        } catch (error) { controller.error(error); }
      },
      cancel(reason) { return reader ? reader.cancel(reason) : source.cancel(reason); },
    }, { highWaterMark: 0 });
    return guardedBody;
  };
  const bytes = async () => {
    check();
    if (consumed || response.bodyUsed || guardedBody?.locked) throw new TypeError("Response body is already used");
    const stream = body();
    if (!stream) return new Uint8Array();
    consumed = true;
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        check();
        if (chunk.done) break;
        chunks.push(chunk.value); length += chunk.value.byteLength;
      }
    } finally { reader.releaseLock(); }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  };
  return new Proxy(response, {
    get(target, key) {
      if (key === "body") return body();
      if (key === "bodyUsed") return consumed || target.bodyUsed;
      if (key === "bytes") return bytes;
      if (key === "arrayBuffer") return async () => (await bytes()).buffer;
      if (key === "text") return async () => new TextDecoder().decode(await bytes());
      if (key === "json") return async () => JSON.parse(new TextDecoder().decode(await bytes()));
      if (key === "blob") return async () => new Blob([(await bytes()).buffer], { type: target.headers.get("content-type") || "" });
      if (key === "formData") return async () => new Response((await bytes()).buffer, { headers: target.headers }).formData();
      if (key === "clone") return () => {
        check();
        if (consumed || guardedBody?.locked || target.bodyUsed) throw new TypeError("Response body is already used");
        return guardProjectResponse(target.clone(), current);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
