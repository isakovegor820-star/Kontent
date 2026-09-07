import { createHash } from "node:crypto";

const PATH = /^\/api\/(?:drafts\/[1-9]\d*\/editorial\/decisions|monthly-campaigns\/[1-9]\d*\/plans)$/u;
const HEADER = "x-aurora-e2e-editorial-id";
const MAX_BYTES = 16_384;
const hash = value => createHash("sha256").update(String(value)).digest("hex");
const positive = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const contentHash = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : null;
const errorName = value => ["TypeError", "AbortError", "Error"].includes(value) ? value : "native_error";

/** Observe only editorial decisions and monthly plan creation.
 * Diagnostic facts only. No caller may use this observer as a cancellation
 * certificate or as permission to retry a mutation. */
export async function installEditorialNativeBodyObserver(context, { baseUrl }) {
  const origin = new URL(baseUrl).origin;
  const documents = new WeakMap(); const calls = []; const requests = []; const collisions = new Set();
  let limitedCalls = 0;
  await context.exposeBinding("__auroraEditorialNativeBody", ({ page, frame }, event) => {
    if (!page || frame !== page.mainFrame()) return;
    if (event.kind === "document") { documents.set(page, event.documentId); return; }
    if (event.kind === "collision") { if (event.identity) collisions.add(event.identity); return; }
    if (event.kind === "limit") { limitedCalls += 1; return; }
    if (event.kind === "start") {
      calls.push({ page, ...event, readers: 0, pending: 0, chunks: 0, bytes: 0, eofCount: 0, closedCount: 0,
        cancelCount: 0, error: null, invalidRead: false, jsonCompletions: 0 });
      return;
    }
    const found = calls.filter(call => call.page === page && call.documentId === event.documentId
      && call.identity === event.identity && call.id === event.id);
    if (found.length !== 1) return;
    const call = found[0];
    if (event.kind === "response") { call.status = event.status; call.contentType = event.contentType; return; }
    if (event.kind === "fetch-error" || event.kind === "body-error" || event.kind === "read-error") call.error ??= errorName(event.error);
    if (event.kind === "reader") { call.readers += 1; call.readerId = event.readerId; return; }
    if (event.kind === "body-cancel") { call.cancelCount += 1; return; }
    if (call.readers !== 1 || call.readerId !== event.readerId) return;
    if (event.kind === "read-start") call.pending += 1;
    if (event.kind === "read") {
      if (call.pending < 1) call.invalidRead = true;
      call.pending = Math.max(0, call.pending - 1);
      if (event.done === true) call.eofCount += 1;
      else if (Number.isSafeInteger(event.bytes) && event.bytes > 0) { call.bytes += event.bytes; call.chunks += 1; }
      else call.invalidRead = true;
      if (!Number.isSafeInteger(call.bytes)) call.invalidRead = true;
    }
    if (event.kind === "read-error") call.pending = Math.max(0, call.pending - 1);
    if (event.kind === "closed") call.closedCount += 1;
    if (event.kind === "cancel") call.cancelCount += 1;
    if (event.kind === "json") {
      call.jsonCompletions += 1; call.bodySha256 = contentHash(event.bodySha256);
      call.responseRequestIdHash = contentHash(event.responseRequestIdHash); call.bodyRequestIdHash = contentHash(event.bodyRequestIdHash);
      call.jsonValid = event.jsonValid === true; call.bodyOk = event.bodyOk === true; call.overflow = event.overflow === true;
      const source = event.receipt;
      call.receipt = source && (call.url && new URL(call.url).pathname.startsWith("/api/monthly-campaigns/") ? {
        planId: positive(source.planId), campaignId: positive(source.campaignId), projectId: positive(source.projectId),
        version: positive(source.version), revision: positive(source.revision), itemCount: positive(source.itemCount),
        duplicate: source.duplicate === true,
      } : {
        decisionId: positive(source.decisionId), draftId: positive(source.draftId), projectId: positive(source.projectId),
        workflowVersion: positive(source.workflowVersion), currentRevisionId: positive(source.currentRevisionId),
        submittedRevisionId: positive(source.submittedRevisionId), approvedRevisionId: positive(source.approvedRevisionId),
        approvedContentHash: contentHash(source.approvedContentHash),
        state: ["approved", "changes_requested"].includes(source.state) ? source.state : null,
      });
    }
  });
  await context.addInitScript(({ origin, header, maxBytes }) => {
    if (location.origin !== origin) return;
    const documentId = crypto.randomUUID(); let sequence = 0;
    const pending = new Set(); const failures = [];
    const observe = work => { pending.add(work); void work.then(() => pending.delete(work), error => {
      failures.push(error); pending.delete(work);
    }); };
    const send = event => observe(window.__auroraEditorialNativeBody({ ...event, documentId }));
    window.__flushEditorialNativeBody = async () => {
      while (pending.size) await Promise.allSettled([...pending]);
      if (failures.length) throw failures[0];
    };
    send({ kind: "document" });
    const digest = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", value))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const stringDigest = value => typeof value === "string" && value ? digest(new TextEncoder().encode(value)) : null;
    const nativeFetch = window.fetch;
    // Observational coverage is intentionally limited to data-valued options.
    // Reading accessors before native WebIDL conversion can change its order,
    // receiver or result. Such callers retain native fetch and no body diagnostic.
    const staticOptions = init => {
      if (init == null) return true;
      if (typeof init !== "object" && typeof init !== "function") return false;
      for (let current = init; current; current = Object.getPrototypeOf(current)) {
        for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(current))) {
          if (key !== "__proto__" && !("value" in descriptor)) return false;
        }
      }
      return true;
    };
    window.fetch = function(input, init) {
      let url; try { url = new URL(input instanceof Request ? input.url : String(input), location.href); }
      catch { return Reflect.apply(nativeFetch, this, [input, init]); }
      if (url.origin !== origin || !/^\/api\/(?:drafts\/[1-9]\d*\/editorial\/decisions|monthly-campaigns\/[1-9]\d*\/plans)$/u.test(url.pathname)
        || !staticOptions(init)) return Reflect.apply(nativeFetch, this, [input, init]);
      const rawMethod = init?.method;
      if (rawMethod !== undefined && typeof rawMethod !== "string") return Reflect.apply(nativeFetch, this, [input, init]);
      const method = (rawMethod ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (method !== "POST" || init?.headers === null) return Reflect.apply(nativeFetch, this, [input, init]);
      if (sequence >= 64) { send({ kind: "limit" }); return Reflect.apply(nativeFetch, this, [input, init]); }
      let headers; try { headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)); }
      catch { return Reflect.apply(nativeFetch, this, [input, init]); }
      if (headers.has(header)) { send({ kind: "collision", identity: headers.get(header) }); return Reflect.apply(nativeFetch, this, [input, init]); }
      const id = ++sequence; const identity = crypto.randomUUID(); headers.set(header, identity);
      const observedInit = new Proxy({ headers }, { get: (target, key) => key === "headers" ? target.headers
        : init == null ? undefined : Reflect.get(init, key, init) });
      const report = event => send({ id, identity, ...event });
      report({ kind: "start", url: url.href, method });
      return Reflect.apply(nativeFetch, this, [input, observedInit]).then(response => {
        const status = response.status; const contentType = response.headers.get("content-type")?.split(";")[0] ?? null;
        const responseRequestId = response.headers.get("x-request-id");
        report({ kind: "response", status, contentType });
        const body = response.body; if (!body) return response;
        const getReader = body.getReader; const bodyCancel = body.cancel; let readers = 0;
        body.cancel = function(...args) { if (this === body) report({ kind: "body-cancel" }); return Reflect.apply(bodyCancel, this, args); };
        body.getReader = function(...args) {
          const reader = Reflect.apply(getReader, this, args); if (this !== body) return reader;
          const readerId = ++readers, emit = event => report({ readerId, ...event });
          const chunks = []; let bytes = 0; let overflow = false; let reported = false;
          emit({ kind: "reader" });
          void reader.closed.then(() => emit({ kind: "closed" }), error => emit({ kind: "body-error", error: error.name }));
          const read = reader.read; const cancel = reader.cancel;
          reader.read = function(...readArgs) {
            if (this !== reader) return Reflect.apply(read, this, readArgs);
            emit({ kind: "read-start" });
            return Reflect.apply(read, this, readArgs).then(value => {
              if (!value.done) {
                bytes += value.value?.byteLength ?? 0;
                if (!(value.value instanceof Uint8Array) || bytes > maxBytes) { overflow = true; chunks.length = 0; }
                else if (!overflow) chunks.push(value.value.slice());
              }
              emit({ kind: "read", done: value.done === true, bytes: value.value?.byteLength ?? 0 });
              if (value.done && !reported) {
                reported = true;
                const work = (async () => {
                  if (overflow) { emit({ kind: "json", overflow: true }); return; }
                  const buffer = new Uint8Array(bytes); let offset = 0;
                  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; } chunks.length = 0;
                  let json; try { json = JSON.parse(new TextDecoder().decode(buffer)); } catch { /* A parse failure remains diagnostic data. */ }
                  const workflow = json?.workflow;
                  emit({ kind: "json", bodySha256: await digest(buffer), jsonValid: json !== undefined, bodyOk: json?.ok === true,
                    responseRequestIdHash: await stringDigest(responseRequestId), bodyRequestIdHash: await stringDigest(json?.requestId),
                    receipt: url.pathname.startsWith("/api/monthly-campaigns/") ? {
                      planId: json?.plan?.id, campaignId: json?.plan?.campaignId, projectId: json?.plan?.projectId,
                      version: json?.plan?.version, revision: json?.plan?.revision, itemCount: json?.plan?.items?.length,
                      duplicate: json?.duplicate,
                    } : workflow && { decisionId: json?.decisionId, draftId: workflow.draftId, projectId: workflow.projectId,
                      workflowVersion: workflow.version, currentRevisionId: workflow.currentRevisionId, submittedRevisionId: workflow.submittedRevisionId,
                      approvedRevisionId: workflow.approvedRevisionId, approvedContentHash: workflow.approvedContentHash, state: workflow.state } });
                })().catch(() => emit({ kind: "body-error", error: "observer_error" }));
                observe(work);
              }
              return value;
            }, error => { emit({ kind: "read-error", error: error.name }); throw error; });
          };
          reader.cancel = function(...cancelArgs) { if (this === reader) emit({ kind: "cancel" }); return Reflect.apply(cancel, this, cancelArgs); };
          return reader;
        };
        return response;
      }, error => { report({ kind: "fetch-error", error: error.name }); throw error; });
    };
  }, { origin, header: HEADER, maxBytes: MAX_BYTES });

  const snapshotFor = record => {
    const request = requests.find(request => request.record === record); if (!request) return null;
    const native = calls.filter(call => call.identity === request.identity);
    const reciprocal = requests.filter(other => other.identity === request.identity);
    const call = native.length === 1 && reciprocal.length === 1 && native[0].page === request.page
      && native[0].documentId === request.documentId && request.documentId && native[0].url === request.url
      && native[0].method === request.method && !collisions.has(request.identity) ? native[0] : null;
    const receipt = call?.receipt ?? null;
    const correlation = Boolean(call?.responseRequestIdHash && call.responseRequestIdHash === call.bodyRequestIdHash
      && request.responseRequestIdHash === call.responseRequestIdHash);
    const complete = Boolean(call && call.readers === 1 && call.pending === 0 && call.eofCount === 1 && call.closedCount === 1
      && call.bytes > 0 && call.bytes <= MAX_BYTES && !call.invalidRead && !call.error && call.cancelCount === 0
      && call.jsonCompletions === 1 && call.bodySha256 && !call.overflow);
    return { requestId: record.id, path: record.path, identityPresent: Boolean(request.identity), identityHash: request.identity ? hash(request.identity) : null,
      nativeMatchCount: native.length, requestMatchCount: reciprocal.length, matched: Boolean(call), collision: collisions.has(request.identity),
      limitedCalls, status: request.status ?? null, contentType: request.contentType ?? null, responseRequestIdHash: request.responseRequestIdHash ?? null,
      projectId: request.projectId, request: request.payload,
      native: call ? { readerCount: call.readers, pendingReads: call.pending, byteCount: call.bytes, chunks: call.chunks, eofCount: call.eofCount,
        fulfilledClosedCount: call.closedCount, cancelCount: call.cancelCount, error: call.error, invalidRead: call.invalidRead,
        overflow: call.overflow === true, bodySha256: call.bodySha256 ?? null, jsonValid: call.jsonValid === true,
        bodyOk: call.bodyOk === true, bodyComplete: complete, responseCorrelation: correlation,
        statusMatches: call.status === request.status && call.contentType === request.contentType } : null,
      receipt };
  };
  return {
    documentFor: page => documents.get(page) ?? null,
    trackRequest(request, record, page) {
      if (record.method !== "POST" || new URL(request.url()).origin !== origin || !PATH.test(record.path)
        || page.context() !== context || request.frame() !== page.mainFrame()) return;
      let payload; try { payload = request.postDataJSON(); } catch { /* Missing/invalid request body remains unavailable. */ }
      requests.push({ request, record, page, documentId: documents.get(page), method: record.method, url: request.url(),
        identity: request.headers()[HEADER] ?? null, projectId: positive(Number(request.headers()["x-aurora-project-id"])),
        payload: payload && record.path.startsWith("/api/monthly-campaigns/") ? {
          expectedCampaignVersion: positive(payload.expectedCampaignVersion),
          idempotencyKeyHash: typeof payload.idempotencyKey === "string" ? hash(payload.idempotencyKey) : null,
          generationMode: payload.generationMode === "editorial_seed" ? "editorial_seed" : null,
        } : payload ? { reviewRequestId: positive(payload.requestId), requestVersion: positive(payload.requestVersion), workflowVersion: positive(payload.workflowVersion),
          revisionId: positive(payload.revisionId), contentHash: contentHash(payload.contentHash),
          decision: ["approve", "request_changes"].includes(payload.decision) ? payload.decision : null } : null });
    },
    observeResponse(response) {
      const request = requests.find(request => request.request === response.request()); if (!request) return;
      request.status = response.status(); request.contentType = response.headers()["content-type"]?.split(";")[0] ?? null;
      const requestId = response.headers()["x-request-id"]; request.responseRequestIdHash = requestId ? hash(requestId) : null;
    },
    snapshotFor,
    flush: page => page.evaluate(() => window.__flushEditorialNativeBody?.()),
  };
}
