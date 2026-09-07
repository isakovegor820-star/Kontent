import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { classifyEditorCancellation } from "./e2e-editor-safety-coverage.mjs";
import { classifyCompletedChannelNotificationRead, installChannelNativeBodyObserver } from "./e2e-channel-native-body-observer.mjs";
import { installEditorialNativeBodyObserver } from "./e2e-editorial-native-body-observer.mjs";
import { captureProductEventBatch, assertProductEventPersistence } from "./e2e-product-event-persistence.mjs";
import { observeFirefoxFavicons } from "./e2e-firefox-favicon-observer.mjs";

const READ_ID_HEADER = "x-aurora-e2e-read-id";
const JSON_COMPLETION_MAX_BYTES = 65_536;
const certificates = new WeakMap();
export const readMainCancellationProof = (proof) => certificates.get(proof)?.() ?? null;
const isAbort = value => /^(?:net::ERR_ABORTED|NS_BINDING_ABORTED|cancelled|Load request cancelled)$/u.test(value ?? "");

/** Track every actual request. An expected read lifetime is evidence for one
 * Request, not permission for GET failures elsewhere in a navigation window. */
export function createMainRequestEvidence({ baseUrl, now = () => performance.timeOrigin + performance.now(), actorForPage = () => null }) {
  const origin = new URL(baseUrl).origin;
  const rows = new Map(); const calls = []; const documents = new WeakMap(); const collisions = new Set();
  const nativeObservers = []; const nativeRows = new Map(); let sequence = 0;
  const faviconObservers = [];
  const editorialObservers = [];
  const get = request => rows.get(request);
  const identityMatches = row => ({
    calls: row.identity ? calls.filter(call => call.identity === row.identity) : [],
    requests: row.identity ? [...rows.values()].filter(other => other.identity === row.identity) : [],
  });
  const rejectedByCallerBeforeBody = call => !call.body && call.callerFailure === true
    && [call.at, call.abortedAt, call.failedAt].every(Number.isFinite)
    && call.abortedAt >= call.at && call.failedAt >= call.abortedAt;
  const isTerminalUnmatchedRead = (call, page) => {
    const matching = identityMatches(call);
    // Fetch can reject with its actual caller signal before Playwright emits a
    // Request. That native operation is terminal; it does not prove no dispatch
    // or exempt any later Request from the normal exact-request checks.
    return call.page === page && call.documentId === documents.get(page) && Boolean(call.documentId)
      && call.method === "GET" && new URL(call.url).origin === origin
      && Boolean(call.identity) && !collisions.has(call.identity)
      && matching.calls.length === 1 && matching.calls[0] === call && matching.requests.length === 0
      && rejectedByCallerBeforeBody(call);
  };
  const nativeFor = row => {
    if (!row.identity || collisions.has(row.identity)) return null;
    const matching = identityMatches(row);
    if (matching.calls.length !== 1 || matching.requests.length !== 1 || matching.requests[0] !== row) return null;
    const call = matching.calls[0];
    return call.page === row.page && call.documentId === row.documentId && Boolean(row.documentId)
      && call.method === "GET" && row.method === "GET" && call.url === row.url ? call : null;
  };
  const reasonFor = row => {
    if (!row?.firstParty) return null;
    if (!row.failure) {
      const call = nativeFor(row);
      // The actual fetch promise can reject with its caller's AbortSignal even
      // when Playwright has emitted Request but no transport terminal event.
      // This settles only that exactly matched read; HTTP/transport outcome
      // stays absent, and any later contradictory event revokes this proof.
      return row.method === "GET" && row.type === "fetch" && row.status == null
        && row.finishedAt == null && row.failedAt == null && call && rejectedByCallerBeforeBody(call)
        ? "native_caller_abort_without_transport_terminal" : null;
    }
    const narrow = classifyEditorCancellation(row);
    if (narrow === "acknowledged_keepalive" || narrow === "completed_rsc_prefetch") return narrow;
    if (row.serverCancellation && isAbort(row.failure)) return "proved_server_generation_cancellation";
    if (row.serverCompletion && isAbort(row.failure)) return "durably_acknowledged_generation";
    if (row.persistedProductEventCount && isAbort(row.failure)) return "durably_persisted_product_events";
    // A cancelled browser-owned tab icon is not a completed application read.
    // Keep its failure visible; only the exact native favicon cause admits it.
    if (faviconObservers.some(observer => observer.isCancelledFavicon(row))) return "browser_cancelled_favicon";
    if (row.method !== "GET" || row.type !== "fetch" || !isAbort(row.failure)) return null;
    for (const observer of nativeObservers) {
      const nativeRow = nativeRows.get(observer)?.get(row.request);
      if (nativeRow && classifyCompletedChannelNotificationRead({ ...row, documentId: nativeRow.documentId }, observer.match(nativeRow))) return "completed_native_notifications_read";
    }
    const call = nativeFor(row);
    if (!call) return null;
    const body = call.body;
    // Next's active Flight reader can finish the original body successfully
    // while the browser reports a late transport cancellation. Binding delivery
    // order is not stream order: require the native EOF AND fulfilled closed
    // Promise, with no native error/cancel, rather than a timestamp allowance.
    if (row.status === 200 && row.contentType === "text/x-component"
      && (row.path === "/" || row.path === "/login" || row.path.startsWith("/app/")) && new URL(row.url).searchParams.has("_rsc")
      && row.rsc === "1" && !row.prefetch && !row.segmentPrefetch
      && body?.readers === 1 && body.pending === 0 && body.eofCount === 1 && body.closedCount === 1
      && body.bytes > 0 && !body.invalidRead && !body.error && body.cancelCount === 0
      && call.callerFailure == null) return "completed_native_rsc_read";
    // This establishes completion of the original JSON transport, not business
    // success or permission. Headers/EOF alone cannot supply valid JSON bytes.
    if (row.status === 200 && row.contentType === "application/json" && row.path.startsWith("/api/")
      && body?.readers === 1 && body.pending === 0 && body.eofCount === 1 && body.closedCount === 1
      && body.bytes > 0 && body.bytes <= JSON_COMPLETION_MAX_BYTES && !body.invalidRead && !body.error && body.cancelCount === 0
      && body.jsonCount === 1 && body.jsonValid === true && body.jsonBytes === body.bytes && !body.jsonOverflow
      && call.callerFailure == null) return "completed_native_json_read";
    if (row.status >= 200 && row.status < 300 && row.contentType === "application/json"
      && body?.readers === 1 && body.cancelCount === 1 && body.cancel?.startedBeforeFailure === true
      && body.cancel.eligible === true && body.cancel.results === 1 && body.cancel.success === true && !body.error
      && call.callerFailure == null) return "explicit_native_reader_cancellation";
    if (call.callerFailure === true && call.abortedAt >= call.at
      && Math.abs(row.failedAt - call.abortedAt) <= 2_000) return "caller_abort_signal";
    // A document commit cannot identify the cause of a transport TypeError.
    // Preserve uncertainty even when pagehide/timing happens to coincide.
    return null;
  };
  const api = {
    observeRequest(request, label, page) {
      if (rows.has(request)) return rows.get(request);
      const url = new URL(request.url()); const headers = request.headers();
      const row = { id: ++sequence, request, page, context: label, url: url.href, path: url.pathname,
        firstParty: url.origin === origin, method: request.method(), type: request.resourceType(), startedAt: now(),
        documentId: documents.get(page), identity: headers[READ_ID_HEADER] || null, rsc: headers.rsc, prefetch: headers["next-router-prefetch"],
        segmentPrefetch: headers["next-router-segment-prefetch"] };
      rows.set(request, row);
      if (row.firstParty && row.method === "POST" && row.type === "fetch" && row.path === "/api/product-events" && !url.search) {
        row.productEventBatch = captureProductEventBatch(request, actorForPage(page), row.startedAt);
      }
      for (const observer of nativeObservers) {
        const nativeRow = { ...row, documentId: observer.documentFor(page) };
        nativeRows.get(observer).set(request, nativeRow); observer.trackRequest(request, nativeRow, page);
      }
      for (const observer of editorialObservers) observer.trackRequest(request, row, page);
      return row;
    },
    observeResponse(response) {
      const row = get(response.request()); if (!row) return;
      row.status = response.status(); row.contentType = response.headers()["content-type"]?.split(";")[0];
      row.serverRequestId = response.headers()["x-ai-request-id"];
      row.aiAcknowledged = response.headers()["x-ai-acknowledged"] === "true";
      for (const observer of editorialObservers) observer.observeResponse(response);
    },
    observeFinished(request) {
      const row = get(request); if (!row) return;
      row.finishedAt = now();
      // WebKit can deliver the document request event after its cancellation
      // event. The finished exact Request's browser timing is authoritative;
      // missing/invalid timing cannot turn a later event into an earlier start.
      const networkStartedAt = request.timing?.().startTime;
      if (Number.isFinite(networkStartedAt) && networkStartedAt > 0) row.networkStartedAt = networkStartedAt;
    },
    observeFailure(request) { const row = get(request); if (row) { row.failure = request.failure()?.errorText; row.failedAt = now(); } },

    // This entry point is also exercised with exact browser binding events in
    // the bounded tests. It never admits a request without a reciprocal match.
    observeNative(page, event) {
      if (event.kind === "document") { documents.set(page, event.documentId); return; }

      if (event.kind === "collision") { if (event.identity) collisions.add(event.identity); return; }
      if (event.kind === "start") { calls.push({ page, ...event }); return; }
      const matching = calls.filter(item => item.page === page && item.documentId === event.documentId
        && item.id === event.id && item.identity && item.identity === event.identity);
      const call = matching.length === 1 ? matching[0] : null;
      if (call && event.kind === "abort") call.abortedAt = event.at;
      // Capture the first actual rejection cause. A later cleanup signal cannot
      // relabel an earlier network TypeError, even in the same clock millisecond.
      if (call && event.kind === "failure" && call.callerFailure == null) {
        call.callerFailure = event.callerAbort === true;
        call.failedAt = event.at;
      }
      if (!call || !event.kind.startsWith("body-")) return;
      const body = call.body ??= { readers: 0, readerId: null, pending: 0, chunks: 0, bytes: 0,
        closed: false, closedCount: 0, eof: false, eofCount: 0, invalidRead: false, error: false, cancelCount: 0 };
      if (event.kind === "body-reader") { body.readers += 1; body.readerId = event.readerId; return; }
      if (body.readers !== 1 || event.readerId !== body.readerId) return;
      if (event.kind === "body-read-start") body.pending += 1;
      if (event.kind === "body-read") {
        if (body.pending < 1) body.invalidRead = true;
        body.pending = Math.max(0, body.pending - 1);
        if (event.done === true) { body.eof = true; body.eofCount += 1; }
        else if (Number.isSafeInteger(event.bytes) && event.bytes > 0) {
          body.chunks += 1; body.bytes += event.bytes;
          if (!Number.isSafeInteger(body.bytes)) body.invalidRead = true;
        } else if (event.bytes !== 0) body.invalidRead = true;
      }
      if (event.kind === "body-closed") { body.closed = true; body.closedCount += 1; }
      if (event.kind === "body-json") {
        body.jsonCount = (body.jsonCount ?? 0) + 1; body.jsonValid = event.valid === true;
        body.jsonBytes = Number.isSafeInteger(event.bytes) && event.bytes >= 0 ? event.bytes : null;
        body.jsonOverflow = event.overflow === true;
      }
      if (event.kind === "body-error" || event.kind === "body-read-error") body.error = true;
      if (event.kind === "body-read-error") body.pending = Math.max(0, body.pending - 1);
      if (event.kind === "body-cancel-start") {
        body.cancelCount += 1;
        const matching = identityMatches({ identity: call.identity });
        const row = matching.requests.length === 1 ? matching.requests[0] : null;
        body.cancel = { id: event.cancelId, startedBeforeFailure: Boolean(row && !row.failure && nativeFor(row) === call),
          eligible: event.eligible === true && event.cancelId === 1 && body.cancelCount === 1
            && !body.closed && !body.eof && !body.error && body.pending === 0 && body.chunks > 0,
          success: false, results: 0 };
      }
      if (event.kind === "body-cancel-result" && event.cancelId === body.cancel?.id) {
        body.cancel.results += 1; body.cancel.success = event.success === true;
      }
    },
    confirmGenerationCancellation(request, { key, cancellation, usage }) {
      const row = get(request);
      assert(row?.method === "POST" && row.firstParty && row.path === "/api/ai/generate", "generation proof requires the captured AI request");
      assert(request.headers()["idempotency-key"] === key && key, "generation proof key mismatch");
      assert(row.status === 200 && row.contentType === "application/x-ndjson"
        && row.serverRequestId && row.serverRequestId === cancellation?.server_request_id, "generation response/cancellation correlation mismatch");
      assert(cancellation.status === "failed" && cancellation.error_code === "ai_generation_cancelled" && cancellation.retryable === false
        && usage?.status === "released" && usage.result_payload == null, "generation cancellation is not durably settled");
      row.serverCancellation = true;
    },
    confirmGenerationCompletion(request, { key, userId, operation, ackRequest, ack }) {
      const row = get(request); const acknowledgement = get(ackRequest);
      assert(row?.firstParty && row.method === "POST" && row.path === "/api/ai/generate"
        && key && request.headers()["idempotency-key"] === key,
      "generation completion requires the exact captured keyed request");
      assert(row.status === 200 && row.contentType === "application/x-ndjson" && row.serverRequestId
        && row.serverRequestId === operation?.server_request_id,
      "generation completion response identity mismatch");
      assert(Number.isSafeInteger(userId) && userId > 0 && Number(operation.user_id) === userId
        && operation.request_key === `web:${key}` && operation.status === "acknowledged"
        && Number.isSafeInteger(Number(operation.project_id)) && Number(operation.project_id) > 0
        && Number(operation.project_id) === Number(request.headers()["x-aurora-project-id"])
        && Number.isSafeInteger(Number(operation.channel_id)) && Number(operation.channel_id) > 0
        && Number(operation.channel_id) === Number(request.postDataJSON()?.channelId)
        && operation.usage_status === "committed" && operation.usage_operation_id === row.serverRequestId
        && operation.result_count === 1 && operation.usage_count === 1
        && Number.isSafeInteger(Number(operation.result_id)) && Number(operation.result_id) > 0
        && operation.result_payload?.protocol === "ndjson"
        && operation.result_payload.generationResultId === Number(operation.result_id)
        && operation.result_payload.text === operation.text,
      "generation completion has no exact acknowledged durable artifact");
      assert(acknowledgement?.firstParty && acknowledgement.method === "POST"
        && acknowledgement.path === "/api/ai/generate/ack" && acknowledgement.page === row.page
        && row.documentId && acknowledgement.documentId === row.documentId
        && ackRequest.headers()["idempotency-key"] === key
        && ackRequest.headers()["x-aurora-project-id"] === request.headers()["x-aurora-project-id"]
        && acknowledgement.status === 200 && acknowledgement.contentType === "application/json"
        && acknowledgement.aiAcknowledged && acknowledgement.serverRequestId
        && acknowledgement.serverRequestId === ack?.requestId && ack.requestKey === key
        && ack.status === 200 && ack.complete === true && !ack.error
        && ack.body?.ok === true && ack.body.status === "committed"
        && ack.body.generationResultId === Number(operation.result_id),
      "generation acknowledgement is incomplete or belongs to another request");
      row.serverCompletion = true;
    },
    productEventReceiptScope(request) {
      const row = get(request); const batch = row?.productEventBatch;
      return batch && (row.status == null || row.status === 200) && isAbort(row.failure) ? { actorUserId: batch.actorUserId, projectId: batch.projectId,
        eventIds: batch.events.map(event => event.eventId) } : null;
    },
    confirmProductEventPersistence(request, { receipts }) {
      const row = get(request);
      assert(row?.productEventBatch && (row.status == null || row.status === 200) && isAbort(row.failure), "product-event proof requires the captured cancelled batch");
      row.persistedProductEventCount = assertProductEventPersistence(row.productEventBatch, receipts);
    },
    reason(request) { return reasonFor(get(request)); },
    snapshot() {
      const timestamp = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
      const resourceTypes = new Set(["document", "stylesheet", "image", "media", "font", "script", "texttrack", "xhr", "fetch", "eventsource", "websocket", "manifest", "other"]);
      return [...rows.values()].map(row => {
        const matching = identityMatches(row); const caller = nativeFor(row);
        return { id: row.id, context: row.context, path: row.path,
          resourceType: resourceTypes.has(row.type) ? row.type : null,
          rscProtocol: { request: row.rsc === "1", query: new URL(row.url).searchParams.has("_rsc"),
            prefetch: Boolean(row.prefetch || row.segmentPrefetch), response: row.contentType === "text/x-component" },
          startedAt: timestamp(row.startedAt), finishedAt: timestamp(row.finishedAt), failedAt: timestamp(row.failedAt),
          nativeStartedAt: timestamp(caller?.at), nativeAbortedAt: timestamp(caller?.abortedAt),
          nativeFailedAt: timestamp(caller?.failedAt),
          // Last observed init when Node saw the Request, not proof that a
          // browser-managed image/document request belongs to that document.
          observedDocumentHashAtRequestStart: typeof row.documentId === "string" && row.documentId
            ? createHash("sha256").update(row.documentId).digest("hex") : null,
          urlHash: createHash("sha256").update(row.url).digest("hex"), method: row.method,
          status: row.status ?? null, failure: row.failure ? (/^(?:net::ERR_[A-Z_]+|NS_BINDING_ABORTED|cancelled|Load request cancelled)$/u.test(row.failure) ? row.failure : "unrecognized_failure") : null,
          callerPresence: matching.calls.length > 0, nativeMatchCount: matching.calls.length,
          requestMatchCount: matching.requests.length, callerMatched: Boolean(caller),
          callerFailure: caller?.callerFailure ?? null,
          bodyCancellation: caller?.body ? { readerCount: caller.body.readers, pendingReads: caller.body.pending,
            fulfilledChunks: caller.body.chunks, closed: caller.body.closed, eof: caller.body.eof, nativeError: caller.body.error,
            cancelCount: caller.body.cancelCount, startedBeforeFailure: caller.body.cancel?.startedBeforeFailure ?? false,
            eligible: caller.body.cancel?.eligible ?? false, resultCount: caller.body.cancel?.results ?? 0, success: caller.body.cancel?.success ?? false } : null,
          bodyCompletion: caller?.body ? { bytes: caller.body.bytes, eofCount: caller.body.eofCount,
            fulfilledClosedCount: caller.body.closedCount, invalidRead: caller.body.invalidRead } : null,
          bodyJson: caller?.body?.jsonCount ? { observations: caller.body.jsonCount, valid: caller.body.jsonValid,
            bytes: caller.body.jsonBytes, overflow: caller.body.jsonOverflow } : null,
          identityPresent: Boolean(row.identity), persistedProductEventCount: row.persistedProductEventCount ?? 0,
          identityCollision: collisions.has(row.identity), reason: reasonFor(row),
          editorialAck: row.path.startsWith("/api/drafts/") ? editorialObservers.map(observer => observer.snapshotFor(row)).find(Boolean) ?? null : null,
          monthlyPlanAck: row.path.startsWith("/api/monthly-campaigns/") ? editorialObservers.map(observer => observer.snapshotFor(row)).find(Boolean) ?? null : null };
      });
    },
    snapshotUnmatchedReads() {
      const recorded = [...rows.values()]; const matched = new Set(recorded.map(nativeFor).filter(Boolean));
      const digest = value => createHash("sha256").update(String(value)).digest("hex");
      return calls.filter(call => call.method === "GET" && !matched.has(call)).map(call => {
        const matching = identityMatches({ identity: call.identity });
        const body = call.body; const failures = matching.requests.filter(row => row.failure);
        let path = null; try { path = new URL(call.url).pathname; } catch { /* Invalid metadata stays unavailable. */ }
        return { nativeId: Number.isSafeInteger(call.id) ? call.id : null,
          context: recorded.find(row => row.page === call.page)?.context ?? null, method: "GET", path,
          urlHash: digest(call.url), documentHash: digest(call.documentId), identityHash: call.identity ? digest(call.identity) : null,
          identityCollision: collisions.has(call.identity), nativeMatchCount: matching.calls.length, requestMatchCount: matching.requests.length,
          requestIds: matching.requests.map(row => row.id), nativeFailureObserved: call.callerFailure != null,
          callerFailure: call.callerFailure ?? null, failed: call.callerFailure != null || Boolean(body?.error) || failures.length > 0,
          requestFailures: failures.map(row => ({ requestId: row.id, status: row.status ?? null,
            failure: /^(?:net::ERR_[A-Z_]+|NS_BINDING_ABORTED|cancelled|Load request cancelled)$/u.test(row.failure) ? row.failure : "unrecognized_failure" })),
          body: body ? { readerCount: body.readers, pendingReads: body.pending, byteCount: body.bytes, eofCount: body.eofCount,
            fulfilledClosedCount: body.closedCount, nativeError: body.error, cancelCount: body.cancelCount, invalidRead: body.invalidRead } : null };
      });
    },
    proofs() {
      return [...rows.values()].flatMap(row => {
        const reason = reasonFor(row); if (!reason) return [];
        const proof = Object.freeze({ requestId: row.id, context: row.context, path: row.path, reason });
        // A token is not a snapshot exemption: late native evidence may revoke
        // its original reason before the consumer performs final admission.
        certificates.set(proof, () => reasonFor(row) === reason
          ? { request: row.request, page: row.page, label: row.context, url: row.url, failure: row.failure, reason }
          : null);
        return [proof];
      });
    },
    async settleReads(page, { timeoutMs = 30_000 } = {}) {
      assert(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000, "read settlement needs a bounded timeout");
      const enteredAtSequence = sequence; const enteredAtNative = calls.length; const deadline = performance.now() + timeoutMs;
      const ownedRead = row => row.page === page && row.firstParty && row.method === "GET";
      const captured = new Set([...rows.values()].filter(row => ownedRead(row) && !row.finishedAt && !row.failure));
      const capturedCalls = new Set(calls.filter(call => call.page === page && call.documentId === documents.get(page)));
      const collect = () => {
        // Include newly observed terminal failures too: a fast failure between
        // polls must not disappear from the navigation barrier.
        for (const row of rows.values()) if (ownedRead(row) && row.id > enteredAtSequence) captured.add(row);
        for (const call of calls.slice(enteredAtNative)) if (call.page === page) capturedCalls.add(call);
      };
      const check = () => {
        let unmatched = false;
        // The native binding can precede the Playwright Request event. A stable
        // count with no reciprocal Request is still an outstanding read.
        for (const call of capturedCalls) {
          const matching = identityMatches(call);
          const row = matching.requests.length === 1 ? matching.requests[0] : null;
          if (!row && isTerminalUnmatchedRead(call, page)) continue;
          if (!row || nativeFor(row) !== call) unmatched = true;
          else captured.add(row);
        }
        const failed = [...captured].find(row => row.failure && !reasonFor(row));
        assert(!failed, `Captured GET failed before navigation: ${failed?.path}`);
        return !unmatched && [...captured].every(row => row.finishedAt || reasonFor(row));
      };
      const epoch = () => ({ requests: [...rows.values()].filter(ownedRead).length,
        native: calls.filter(call => call.page === page).length, document: documents.get(page) });
      const rendererCheckpoint = async () => {
        const remaining = Math.ceil(deadline - performance.now());
        assert(remaining > 0, "Captured GET did not settle before navigation");
        const work = page.evaluate(async ({ origin }) => {
          if (location.href === "about:blank" && typeof window.__auroraMainReadSettlement !== "function") return { uninitialized: true };
          if (location.origin !== origin || typeof window.__auroraMainReadSettlement !== "function") throw new Error("Owned renderer settlement observer is unavailable");
          return window.__auroraMainReadSettlement();
        }, { origin });
        // A failed/closed renderer must still reject through the original work;
        // observe it immediately if the bounded timeout wins first.
        void work.catch(() => undefined); let timer;
        try {
          const result = await Promise.race([work, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("Captured GET renderer checkpoint timed out before navigation")), remaining);
          })]);
          if (result?.uninitialized) assert(!documents.has(page) && ![...rows.values()].some(row => row.page === page && row.firstParty), "Only an unused about:blank page may omit the owned renderer checkpoint");
          else assert(result?.documentId && result.documentId === documents.get(page), "Renderer settlement document changed or was not observed");
        } finally { clearTimeout(timer); }
      };
      for (;;) {
        collect();
        if (check()) {
          // React/visibility callbacks may enqueue reads on the next frame even
          // when no Request was pending at entry. Flush rendering/native binding
          // delivery, then require a stable completed set before navigation.
          const before = epoch(); await rendererCheckpoint(); collect();
          const after = epoch();
          if (check() && before.requests === after.requests && before.native === after.native && before.document === after.document) {
            assert(performance.now() < deadline, "Captured GET did not settle before navigation");
            return;
          }
        }
        assert(performance.now() < deadline, "Captured GET did not settle before navigation");
        await new Promise(resolve => setTimeout(resolve, Math.min(20, timeoutMs, Math.max(1, deadline - performance.now()))));
      }
    },
    async flushNativeDiagnostics(page, { timeoutMs = 3_000 } = {}) {
      assert(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10_000, "native diagnostic flush needs a bounded timeout");
      let timer;
      try {
        await Promise.race([Promise.all(editorialObservers.map(observer => observer.flush(page))),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Native diagnostic flush timed out")), timeoutMs); })]);
      } finally { clearTimeout(timer); }
    },
    async install(context) {
      faviconObservers.push(observeFirefoxFavicons(context, { baseUrl }));
      editorialObservers.push(await installEditorialNativeBodyObserver(context, { baseUrl }));
      const native = await installChannelNativeBodyObserver(context, { baseUrl }); nativeObservers.push(native); nativeRows.set(native, new Map());
      await context.exposeBinding("__auroraMainReadLifetime", ({ page, frame }, event) => {
        if (page && frame === page.mainFrame()) api.observeNative(page, event);
      });
      await context.addInitScript(({ origin, readIdHeader, jsonMaxBytes }) => {
        if (location.origin !== origin) return;
        const documentId = crypto.randomUUID(); let sequence = 0;
        const send = event => { void window.__auroraMainReadLifetime({ ...event, documentId, at: Date.now() }).catch(() => {}); };
        send({ kind: "document" });
        window.__auroraMainReadSettlement = async () => {
          // Complete rendering callbacks and their following task, then await
          // the existing binding so prior native-start events reach Node.
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0))));
          await window.__auroraMainReadLifetime({ kind: "settlement-barrier", documentId, at: Date.now() });
          return { documentId };
        };

        const nativeFetch = window.fetch;
        window.fetch = function (input, init) {
          const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
          let url; try { url = new URL(input instanceof Request ? input.url : String(input), location.href); } catch { return Reflect.apply(nativeFetch, this, [input, init]); }
          if (method !== "GET" || url.origin !== origin || sequence >= 512
            || (init != null && typeof init !== "object" && typeof init !== "function")) return Reflect.apply(nativeFetch, this, [input, init]);
          let headers;
          try { headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)); }
          catch { return Reflect.apply(nativeFetch, this, [input, init]); }
          // A caller-supplied marker is not ours. Preserve the original call but
          // never let it borrow evidence from a prior instrumented request.
          if (headers.has(readIdHeader)) {
            send({ kind: "collision", identity: headers.get(readIdHeader) });
            return Reflect.apply(nativeFetch, this, [input, init]);
          }
          const id = ++sequence; const identity = crypto.randomUUID(); headers.set(readIdHeader, identity);
          // Fetch's dictionary reads retain the original accessor receiver,
          // including private fields and inherited/non-enumerable options. An
          // independent target also preserves frozen init.headers invariants.
          const observedInit = new Proxy({ headers }, { get: (target, key) => key === "headers"
            ? target.headers : init == null ? undefined : Reflect.get(init, key, init) });
          send({ kind: "start", id, identity, method, url: url.href });
          const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
          if (signal?.aborted) send({ kind: "abort", id, identity });
          else if (signal) signal.addEventListener("abort", () => send({ kind: "abort", id, identity }), { once: true });
          const rejected = error => {
            // WebKit clones the native AbortError DOMException; unlike a
            // network TypeError, it still carries this signal's abort cause.
            const nativeAbort = error instanceof DOMException && error.name === "AbortError"
              && signal?.reason instanceof DOMException && signal.reason.name === "AbortError";
            send({ kind: "failure", id, identity, callerAbort: signal?.aborted === true && (error === signal.reason || nativeAbort) });
            throw error;
          };
          return Reflect.apply(nativeFetch, this, [input, observedInit]).then(response => {
            // Observe the actual caller's body operation too: abort can follow
            // response headers. Never clone/read/cancel a body for evidence.
            for (const method of ["json", "text", "arrayBuffer", "blob", "formData"]) {
              const original = response[method];
              response[method] = function (...args) { return Reflect.apply(original, this, args).catch(rejected); };
            }
            if (response.body) {
              const originalBody = response.body; const getReader = originalBody.getReader; let readers = 0;
              const observeJson = url.pathname.startsWith("/api/") && response.status === 200
                && response.headers.get("content-type")?.split(";")[0] === "application/json";
              originalBody.getReader = function (...args) {
                const reader = Reflect.apply(getReader, this, args);
                if (this !== originalBody) return reader;
                const readerId = ++readers; let pending = 0; let chunks = 0; let open = true; let errorSeen = false; let eof = false; let cancels = 0;
                const jsonChunks = []; let jsonBytes = 0; let jsonOverflow = false; let jsonReported = false;
                const report = event => send({ id, identity, readerId, ...event });
                report({ kind: "body-reader" });
                void reader.closed.then(() => { open = false; report({ kind: "body-closed" }); }, () => {
                  open = false; errorSeen = true; report({ kind: "body-error" });
                });
                const read = reader.read; const cancel = reader.cancel;
                reader.read = function (...readArgs) {
                  if (this !== reader) return Reflect.apply(read, this, readArgs);
                  pending += 1; report({ kind: "body-read-start" });
                  return Reflect.apply(read, this, readArgs).then(value => {
                    pending -= 1; const bytes = value.value?.byteLength;
                    if (value.done) eof = true;
                    else if (Number.isSafeInteger(bytes) && bytes > 0) chunks += 1;
                    report({ kind: "body-read", done: value.done === true, bytes: Number.isSafeInteger(bytes) ? bytes : 0 });
                    if (observeJson) {
                      // Copy only bytes already returned by this original read.
                      // Never read/clone a Response for evidence or export JSON.
                      if (!value.done) {
                        jsonBytes += Number.isSafeInteger(bytes) ? bytes : 0;
                        if (!(value.value instanceof Uint8Array) || jsonBytes > jsonMaxBytes) { jsonOverflow = true; jsonChunks.length = 0; }
                        else if (!jsonOverflow) jsonChunks.push(value.value.slice());
                      } else if (!jsonReported) {
                        jsonReported = true; let valid = false;
                        if (!jsonOverflow && jsonBytes > 0) {
                          const buffer = new Uint8Array(jsonBytes); let offset = 0;
                          for (const chunk of jsonChunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
                          try { JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)); valid = true; } catch { /* Malformed JSON remains unproved. */ }
                        }
                        jsonChunks.length = 0;
                        report({ kind: "body-json", valid, bytes: jsonBytes, overflow: jsonOverflow });
                      }
                    }
                    return value;
                  }, error => { pending -= 1; errorSeen = true; report({ kind: "body-read-error" }); return rejected(error); });
                };
                reader.cancel = function (...cancelArgs) {
                  if (this !== reader) return Reflect.apply(cancel, this, cancelArgs);
                  const cancelId = ++cancels;
                  report({ kind: "body-cancel-start", cancelId,
                    eligible: readers === 1 && cancels === 1 && open && !errorSeen && !eof && pending === 0 && chunks > 0 });
                  let work;
                  try { work = Reflect.apply(cancel, this, cancelArgs); }
                  catch (error) { report({ kind: "body-cancel-result", cancelId, success: false }); throw error; }
                  // Observe the original Promise while returning it unchanged.
                  // No binding wait, extra body read, clone, or cancellation.
                  void work.then(() => report({ kind: "body-cancel-result", cancelId, success: true }), () => {
                    report({ kind: "body-cancel-result", cancelId, success: false });
                  });
                  return work;
                };
                return reader;
              };
            }
            return response;
          }, rejected);
        };
      }, { origin, readIdHeader: READ_ID_HEADER, jsonMaxBytes: JSON_COMPLETION_MAX_BYTES });
      return native;
    },
  };
  return api;
}
