const PATH = "/api/project-notifications";
const MAX_BYTES = 65_536;

/** Only a response the same native caller has read to EOF can explain this signal. */
export function classifyCompletedChannelNotificationRead(request, proof) {
  if (request?.firstParty !== true || request.type !== "fetch" || request.method !== "GET" || request.path !== PATH
    || request.failure !== "net::ERR_ABORTED" || !(request.status >= 200 && request.status < 300)
    || request.contentType !== "application/json") return null;
  if (!proof || proof.unambiguous !== true || !request.documentId || proof.documentId !== request.documentId
    || proof.requestId !== request.id || proof.bodyDone !== true || proof.jsonValid !== true
    || proof.cancelled !== false || proof.overflow !== false || proof.error !== null
    || proof.status !== request.status || proof.contentType !== request.contentType
    || !Number.isSafeInteger(proof.bytes) || proof.bytes <= 0 || proof.bytes > MAX_BYTES) return null;
  return "completed_native_notifications_read";
}

/** Observe one bounded GET body in its actual caller; never clone, cancel or replace transport. */
export async function installChannelNativeBodyObserver(context, { baseUrl }) {
  const origin = new URL(baseUrl).origin;
  if (origin === "null") throw new TypeError("Application origin is required for the native body observer");
  const documents = new WeakMap(); const calls = []; const requests = [];
  await context.exposeBinding("__recordChannelNativeBody", ({ page, frame }, event) => {
    if (!page || frame !== page.mainFrame()) return;
    if (event.kind === "document") { documents.set(page, event.documentId); return; }
    if (event.kind === "start") {
      calls.push({ page, documentId: event.documentId, nativeId: event.id, url: event.url, startedAt: event.at, completions: 0 });
      return;
    }
    const call = calls.find((item) => item.page === page && item.documentId === event.documentId && item.nativeId === event.id);
    if (!call || event.kind !== "complete") return;
    call.completions += 1;
    Object.assign(call, { status: event.status, contentType: event.contentType, bodyDone: event.bodyDone,
      bytes: event.bytes, jsonValid: event.jsonValid, cancelled: event.cancelled, overflow: event.overflow,
      error: event.error, completedAt: event.at });
  });
  await context.addInitScript(({ path, maxBytes, origin }) => {
    // A new page runs init scripts in about:blank before the application exists.
    // Observe only the configured application, without hiding missing APIs there.
    if (location.origin !== origin) return;
    const documentId = crypto.randomUUID(); let sequence = 0;
    const pending = new Set();
    const send = (event) => {
      const work = window.__recordChannelNativeBody({ ...event, documentId, at: Date.now() });
      pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work));
    };
    window.__flushChannelNativeBody = () => Promise.all([...pending]);
    send({ kind: "document" });
    const nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      let url;
      try { url = new URL(input instanceof Request ? input.url : String(input), location.href); }
      catch { return Reflect.apply(nativeFetch, this, [input, init]); }
      const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (url.origin !== location.origin || url.pathname !== path || method !== "GET" || sequence >= 64) {
        return Reflect.apply(nativeFetch, this, [input, init]);
      }
      const id = ++sequence;
      send({ kind: "start", id, url: url.href });
      return Reflect.apply(nativeFetch, this, [input, init]).then((response) => {
        const chunks = []; let bytes = 0; let cancelled = false; let overflow = false; let completed = false; let readers = 0;
        const status = response.status; const contentType = response.headers.get("content-type")?.split(";")[0] ?? null;
        const complete = (bodyDone, error = null) => {
          if (completed) return;
          completed = true;
          let jsonValid = false;
          if (bodyDone && !error && !cancelled && !overflow && readers === 1) {
            const joined = new Uint8Array(bytes); let offset = 0;
            for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
            try { JSON.parse(new TextDecoder().decode(joined)); jsonValid = true; } catch { /* Invalid JSON stays unexpected. */ }
          }
          chunks.length = 0;
          send({ kind: "complete", id, status, contentType, bodyDone, bytes, jsonValid, cancelled, overflow, error });
        };
        const body = response.body;
        if (!body) { complete(false, "missing_body"); return response; }
        const nativeGetReader = body.getReader;
        body.getReader = function (...args) {
          const reader = Reflect.apply(nativeGetReader, this, args); readers += 1;
          const nativeRead = reader.read; const nativeCancel = reader.cancel;
          reader.read = function (...readArgs) {
            return Reflect.apply(nativeRead, this, readArgs).then((chunk) => {
              if (chunk.done) complete(true);
              else if (!completed) {
                bytes += chunk.value?.byteLength ?? 0;
                if (!(chunk.value instanceof Uint8Array) || bytes > maxBytes) { overflow = true; chunks.length = 0; }
                else if (!overflow) chunks.push(chunk.value.slice());
              }
              return chunk;
            }, (error) => { complete(false, ["TypeError", "AbortError", "Error"].includes(error.name) ? error.name : "read_error"); throw error; });
          };
          reader.cancel = function (...cancelArgs) {
            cancelled = true; complete(false, "cancelled");
            return Reflect.apply(nativeCancel, this, cancelArgs);
          };
          return reader;
        };
        const nativeBodyCancel = body.cancel;
        body.cancel = function (...cancelArgs) {
          cancelled = true; complete(false, "cancelled");
          return Reflect.apply(nativeBodyCancel, this, cancelArgs);
        };
        return response;
      });
    };
  }, { path: PATH, maxBytes: MAX_BYTES, origin });
  const match = (record) => {
    const request = requests.find((item) => item.record === record);
    if (!request || !record.documentId) return null;
    const sameRequest = (item) => item.page === request.page && item.documentId === record.documentId && item.url === request.url;
    const native = calls.filter(sameRequest);
    if (requests.filter(sameRequest).length !== 1 || native.length !== 1 || native[0].completions !== 1) return null;
    const call = native[0];
    return { unambiguous: true, documentId: record.documentId, requestId: record.id, nativeId: call.nativeId,
      status: call.status, contentType: call.contentType, bodyDone: call.bodyDone, bytes: call.bytes,
      jsonValid: call.jsonValid, cancelled: call.cancelled, overflow: call.overflow, error: call.error,
      startedAt: call.startedAt, completedAt: call.completedAt };
  };
  return {
    documentFor: (page) => documents.get(page) ?? null,
    trackRequest(request, record, page) {
      if (record.method === "GET" && record.path === PATH && request.frame() === page.mainFrame()) {
        requests.push({ page, documentId: record.documentId, url: request.url(), record });
      }
    },
    match,
    flush: (page) => page.evaluate(() => window.__flushChannelNativeBody?.()),
    snapshot: () => calls.map(({ page, url, ...call }) => ({ ...call, path: PATH,
      requestIds: requests.filter((item) => item.page === page && item.documentId === call.documentId && item.url === url).map((item) => item.record.id) })),
  };
}
