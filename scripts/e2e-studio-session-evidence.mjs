import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const PATH = "/api/studio/session";
const MAX_BYTES = 8_100_000;
const proofs = new WeakMap();
const checkpoints = new WeakMap();
const departureTickets = new WeakMap();
const sha = value => createHash("sha256").update(value).digest("hex");
// PostgreSQL jsonb may reorder object properties. Compare the complete JSON
// value after the actual product parser, preserving array order and value types.
const canonicalJson = value => {
  const encode = item => {
    if (Array.isArray(item)) return `[${item.map(encode).join(",")}]`;
    if (item && typeof item === "object") return `{${Object.keys(item).sort()
      .map(key => `${JSON.stringify(key)}:${encode(item[key])}`).join(",")}}`;
    return JSON.stringify(item);
  };
  // Match JSON serialization semantics for the parser's optional undefined fields.
  return encode(JSON.parse(JSON.stringify(value)));
};
const abort = value => /^(?:net::ERR_ABORTED|NS_BINDING_ABORTED|cancelled|Load request cancelled)$/u.test(value ?? "");
export const readStudioSessionProof = proof => {
  const value = proofs.get(proof);
  return value?.valid() ? value.certificate : null;
};

/** Execute only this existing, closed pure-module dependency set. No app build,
 * environment loading, database import, or approximation of normalization. */
export function loadStudioSessionContract({ sourceRoot = process.cwd() } = {}) {
  const paths = ["src/lib/ai-visible-content.mjs", "src/lib/post-settings.ts", "src/lib/studio-chat-session.ts"];
  const modules = new Map(); const hashes = {};
  for (const path of paths) {
    const source = readFileSync(resolve(sourceRoot, path), "utf8"); hashes[path] = sha(source);
    const javascript = ts.transpileModule(source, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    } }).outputText;
    const exports = {};
    const requirePure = name => { assert(modules.has(name), "unexpected Studio parser dependency"); return modules.get(name); };
    new Function("exports", "require", javascript)(exports, requirePure);
    modules.set(`./${path.split("/").at(-1).replace(/\.ts$/u, "")}`, exports);
  }
  const contract = modules.get("./studio-chat-session");
  return { normalizeSession: (payload, owner) => contract.parseStudioChatSession(JSON.stringify(payload), owner),
    storageKeyForOwner: contract.studioChatStorageKey, hashes };
}

/** A persisted snapshot is not a successful original request. Native invocation,
 * local recovery, and an exact owner/revision CAS receipt are all required. */
export function createStudioSessionEvidence({ baseUrl, normalizeSession, storageKeyForOwner }) {
  assert.equal(typeof normalizeSession, "function", "use the actual Studio session parser");
  assert.equal(typeof storageKeyForOwner, "function", "use the actual Studio storage key contract");
  const exampleKey = storageKeyForOwner(1);
  assert(/^aurora:studio-chat:v[1-9]\d*:user-1$/u.test(exampleKey), "unexpected Studio storage key contract");
  const storagePrefix = exampleKey.slice(0, -1);
  const origin = new URL(baseUrl).origin;
  const rows = new Map(); const invocations = []; const confirmed = new Map();
  const documents = new WeakMap(); const reads = []; const writes = []; const tickets = [];
  let readSequence = 0; let writeSequence = 0;
  let sequence = 0;
  const normalized = (payload, owner) => {
    assert(Number.isSafeInteger(owner) && owner > 0 && payload?.owner === owner, "Studio owner mismatch");
    const value = normalizeSession(payload, owner);
    assert(value && typeof value === "object", "invalid Studio snapshot");
    return canonicalJson(value);
  };
  // These fields are deliberately absent from the server payload, but they
  // decide whether recovery preserves an intentional empty draft over remote.
  const recoveryMetadata = payload => JSON.stringify({ localDraftPending: payload.localDraftPending === true,
    localSnapshotId: typeof payload.localSnapshotId === "string" && /^[0-9a-f-]{36}$/u.test(payload.localSnapshotId)
      ? payload.localSnapshotId : null });
  const recoveryIdentity = (payload, owner) => JSON.stringify({ content: normalized(payload, owner), ...JSON.parse(recoveryMetadata(payload)) });
  const parseBody = raw => {
    assert.equal(typeof raw, "string", "Studio body must be captured exactly");
    assert(Buffer.byteLength(raw) <= MAX_BYTES, "Studio observation exceeds bound");
    const value = JSON.parse(raw);
    assert(Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0, "invalid Studio CAS revision");
    return value;
  };
  const match = row => {
    const calls = invocations.filter(call => call.page === row.page && call.body === row.body);
    const requests = [...rows.values()].filter(other => other.page === row.page && other.body === row.body);
    return calls.length === 1 && requests.length === 1 && requests[0] === row ? calls[0] : null;
  };
  const receiptFor = (receipts, owner, content, revision) => {
    assert(Array.isArray(receipts), "actual CAS receipts required");
    return receipts.find(receipt => Number(receipt.user_id) === owner
      && Number.isSafeInteger(Number(receipt.revision)) && Number(receipt.revision) > 0
      && (revision === undefined || Number(receipt.revision) === revision)
      && normalized(receipt.payload, owner) === content);
  };
  const api = {
    observeNative(page, event) {
      if (typeof event?.documentId !== "string" || !event.documentId) return;
      if (event.kind === "document") { documents.set(page, event.documentId); return; }
      if (event.kind === "read") {
        if (Number.isSafeInteger(event.owner) && event.owner > 0 && typeof event.raw === "string"
          && Buffer.byteLength(event.raw) <= MAX_BYTES && reads.length < 512) {
          reads.push({ page, documentId: event.documentId, owner: event.owner, raw: event.raw, sequence: ++readSequence });
        }
        return;
      }
      if (event.kind === "write") {
        if (event.leaving === true && Number.isSafeInteger(event.owner) && event.owner > 0
          && typeof event.raw === "string" && Buffer.byteLength(event.raw) <= MAX_BYTES && writes.length < 128) {
          writes.push({ page, documentId: event.documentId, owner: event.owner, raw: event.raw, sequence: readSequence, writeSequence: ++writeSequence });
        }
        return;
      }
      if (event?.kind !== "put" || typeof event.documentId !== "string" || !event.documentId
        || typeof event.body !== "string" || Buffer.byteLength(event.body) > MAX_BYTES
        || typeof event.local !== "string" || Buffer.byteLength(event.local) > MAX_BYTES
        || invocations.length >= 128) return;
      invocations.push({ page, documentId: event.documentId, body: event.body, local: event.local,
        keepalive: event.keepalive, leaving: event.leaving, sequence: readSequence });
    },
    observeRequest(request, label, page) {
      const url = new URL(request.url());
      if (url.origin !== origin || url.pathname !== PATH || url.search || request.method() !== "PUT") return;
      if (!rows.has(request)) rows.set(request, { id: ++sequence, request, page, label,
        body: request.postData(), failure: null });
    },
    observeFailure(request) { const row = rows.get(request); if (row) row.failure = request.failure()?.errorText; },
    requestsFor(page) { return [...rows.values()].filter(row => row.page === page).map(row => row.request); },
    async checkpoint(page, { owner }) {
      const raw = await page.evaluate(key => localStorage.getItem(key), storageKeyForOwner(owner));
      assert.equal(typeof raw, "string", "Studio local recovery is missing");
      assert(Buffer.byteLength(raw) <= MAX_BYTES, "Studio checkpoint exceeds bound");
      const payload = JSON.parse(raw); const content = normalized(payload, owner);
      const documentId = documents.get(page);
      assert(documentId, "Studio checkpoint document is unobserved");
      const checkpoint = Object.freeze({ owner, hash: sha(content) });
      checkpoints.set(checkpoint, { page, owner, content, recoveryIdentity: recoveryIdentity(payload, owner), documentId, sequence: readSequence });
      return checkpoint;
    },
    async departureTicket(page, { owner, requestKey }) {
      assert(typeof requestKey === "string" && requestKey, "exact active Studio generation key required");
      assert(tickets.length < 128, "Studio departure observation exceeds bound");
      const raw = await page.evaluate(key => localStorage.getItem(key), storageKeyForOwner(owner));
      assert(typeof raw === "string" && Buffer.byteLength(raw) <= MAX_BYTES, "Studio departure baseline is missing");
      const payload = JSON.parse(raw); const content = normalized(payload, owner); const baseline = JSON.parse(content);
      const documentId = documents.get(page);
      assert(documentId, "Studio departure document is unobserved");
      // Replayed UI messages have distinct message IDs but retain the same operation key.
      assert(baseline.generations.some(([, generation]) => generation.requestKey === requestKey),
        "missing active Studio generation key");
      assert.equal(new Set(baseline.messages.map(message => message.id)).size, baseline.messages.length, "ambiguous Studio baseline message identity");
      assert.equal(new Set(baseline.generations.map(([id]) => id)).size, baseline.generations.length, "ambiguous Studio generation identity");
      const streamingIds = new Set(payload.messages.filter(message => message.streaming === true).map(message => message.id));
      const ticket = Object.freeze({ owner, baselineHash: sha(content) });
      departureTickets.set(ticket, { page, owner, baseline, content, payload, documentId, streamingIds, writeSequence,
        recoveryMetadata: recoveryMetadata(payload), sequence: readSequence });
      tickets.push(ticket);
      return ticket;
    },
    checkpointForDeparture(ticket) {
      const prior = departureTickets.get(ticket);
      assert(prior, "foreign Studio departure ticket");
      const matches = writes.filter(write => write.page === prior.page && write.owner === prior.owner
        && write.documentId === prior.documentId && write.writeSequence > prior.writeSequence);
      assert.equal(matches.length, 1, "missing or ambiguous successful Studio departure storage write");
      const write = matches[0]; const payload = JSON.parse(write.raw); const content = normalized(payload, prior.owner);
      const next = JSON.parse(content);
      const messages = new Map(next.messages.map(message => [message.id, message]));
      assert.equal(messages.size, next.messages.length, "ambiguous Studio departure message identity");
      for (const message of prior.baseline.messages) {
        const current = messages.get(message.id);
        assert(current && current.role === message.role, prior.streamingIds.has(message.id)
          ? "Studio departure lost prior streaming message identity" : "Studio departure lost independently captured stable history");
        if (!prior.streamingIds.has(message.id)) assert.equal(JSON.stringify(current), JSON.stringify(message),
          "Studio departure changed independently captured stable history");
      }
      const generations = new Map(next.generations);
      assert.equal(generations.size, next.generations.length, "ambiguous Studio departure generation identity");
      for (const [id, generation] of prior.baseline.generations) assert.equal(JSON.stringify(generations.get(id)), JSON.stringify(generation),
        "Studio departure changed independently captured generation identity");
      assert.equal(next.draft, prior.baseline.draft, "Studio departure changed independently captured draft");
      assert.equal(next.workspaceMode, prior.baseline.workspaceMode, "Studio departure changed workspace");
      assert.equal(recoveryMetadata(payload), prior.recoveryMetadata, "Studio departure changed local recovery intent");
      const checkpoint = Object.freeze({ owner: prior.owner, hash: sha(content) });
      checkpoints.set(checkpoint, { page: prior.page, owner: prior.owner, content, recoveryIdentity: recoveryIdentity(payload, prior.owner),
        documentId: write.documentId, sequence: write.sequence });
      return checkpoint;
    },
    checkpointForRequest(request, { owner }) {
      const row = rows.get(request); const call = row && match(row);
      assert(call && call.keepalive === true && call.leaving === true, "missing unique native pagehide checkpoint");
      const local = JSON.parse(call.local); const content = normalized(local, owner);
      assert.equal(content, normalized(parseBody(row.body).session, owner), "native local checkpoint differs from outgoing content");
      const checkpoint = Object.freeze({ owner, hash: sha(content) });
      checkpoints.set(checkpoint, { page: row.page, owner, content, recoveryIdentity: recoveryIdentity(local, owner),
        documentId: call.documentId, sequence: call.sequence });
      return checkpoint;
    },
    checkpointForPageHide(page, { owner, generationResultId, text }) {
      assert(Number.isSafeInteger(generationResultId) && generationResultId > 0 && typeof text === "string" && text,
        "exact generated result identity required");
      const matches = writes.filter(write => write.page === page && write.owner === owner).filter(write => {
        const value = JSON.parse(normalized(JSON.parse(write.raw), owner));
        return value.messages.some(message => message.role === "ai" && message.generationResultId === generationResultId && message.text === text);
      });
      assert.equal(matches.length, 1, "missing or ambiguous successful Studio pagehide storage write");
      const write = matches[0]; const payload = JSON.parse(write.raw); const content = normalized(payload, owner);
      const checkpoint = Object.freeze({ owner, hash: sha(content) });
      checkpoints.set(checkpoint, { page, owner, content, recoveryIdentity: recoveryIdentity(payload, owner),
        documentId: write.documentId, sequence: write.sequence });
      return checkpoint;
    },
    async assertRenderedMessages(checkpoint, page) {
      const expected = checkpoints.get(checkpoint);
      assert(expected && expected.page === page, "foreign Studio UI checkpoint");
      const wanted = new Map();
      for (const message of JSON.parse(expected.content).messages) {
        if (message.role !== "user" && !message.text.trim()) continue;
        if (message.text) wanted.set(message.text, (wanted.get(message.text) ?? 0) + 1);
      }
      const rendered = await page.getByRole("region", { name: "Диалог с ИИ", exact: true })
        .locator("p.whitespace-pre-wrap").allTextContents();
      const counts = new Map(); for (const text of rendered) counts.set(text, (counts.get(text) ?? 0) + 1);
      for (const [text, count] of wanted) assert((counts.get(text) ?? 0) >= count,
        `Studio rendered history lost expected message content ${sha(text)}`);
      return { expectedMessages: [...wanted.values()].reduce((sum, count) => sum + count, 0),
        distinctContentHashes: [...wanted.keys()].map(sha) };
    },
    async assertRestored(checkpoint, page, { owner }) {
      const expected = checkpoints.get(checkpoint);
      assert(expected && expected.page === page && expected.owner === owner, "foreign Studio checkpoint");
      const currentDocument = documents.get(page);
      assert(currentDocument && currentDocument !== expected.documentId, "Studio recovery needs a new observed document");
      assert(reads.some(read => read.page === page && read.owner === owner && read.documentId === currentDocument
        && read.sequence > expected.sequence && recoveryIdentity(JSON.parse(read.raw), owner) === expected.recoveryIdentity),
      "no exact native restoration read for the independently captured Studio snapshot");
    },
    assertCheckpointPersisted(checkpoint, { owner, receipts }) {
      const expected = checkpoints.get(checkpoint);
      assert(expected && expected.owner === owner, "foreign Studio checkpoint");
      assert(receiptFor(receipts, owner, expected.content), "no exact CAS receipt for Studio checkpoint");
    },
    confirmPersisted(request, { owner, receipts }) {
      const row = rows.get(request);
      assert(row && abort(row.failure), "only the actual failed Studio PUT can receive a persistence proof");
      const call = match(row);
      assert(call && call.keepalive === true && call.leaving === true, "missing unique native pagehide invocation");
      const input = parseBody(row.body); const content = normalized(input.session, owner);
      const local = JSON.parse(call.local);
      assert.equal(normalized(local, owner), content, "local recovery differs from the outgoing Studio snapshot");
      const receipt = receiptFor(receipts, owner, content, input.expectedRevision + 1);
      assert(receipt, "exact owner/body/CAS revision receipt is absent");
      const proof = Object.freeze({ requestId: row.id, context: row.label, path: PATH,
        reason: "persisted_studio_snapshot", owner, revision: Number(receipt.revision), contentHash: sha(content) });
      proofs.set(proof, { valid: () => match(row) === call && abort(row.failure),
        certificate: { request, page: row.page, label: row.label, url: request.url(),
          failure: row.failure, reason: proof.reason } });
      confirmed.set(request, proof);
      return proof;
    },
    proofs() { return [...confirmed.values()].filter(proof => readStudioSessionProof(proof)); },
    recoverySnapshot() {
      return reads.map(read => {
        let contentHash = null;
        try { contentHash = sha(normalized(JSON.parse(read.raw), read.owner)); } catch { /* Invalid reads are never proof. */ }
        return { sequence: read.sequence, owner: read.owner, documentHash: sha(read.documentId), contentHash };
      });
    },
    departureSnapshot() {
      return tickets.map(ticket => {
        const prior = departureTickets.get(ticket);
        const matchingWrites = writes.filter(write => write.page === prior.page && write.owner === prior.owner
          && write.documentId === prior.documentId && write.writeSequence > prior.writeSequence);
        return { owner: prior.owner, documentHash: sha(prior.documentId), baselineHash: sha(prior.content),
          recoveryIdentityHash: sha(prior.recoveryMetadata), stableMessageCount: prior.baseline.messages.length - prior.streamingIds.size,
          generationCount: prior.baseline.generations.length, matchingWrites: matchingWrites.length,
          writes: matchingWrites.map(write => { try { const value = JSON.parse(write.raw); return {
            contentHash: sha(normalized(value, write.owner)), recoveryIdentityHash: sha(recoveryMetadata(value)) };
          } catch { return { contentHash: null, recoveryIdentityHash: null }; } }) };
      });
    },
    snapshot({ owner, receipts } = {}) {
      return [...rows.values()].map(row => {
        const call = match(row); const calls = invocations.filter(value => value.page === row.page && value.body === row.body);
        const requests = [...rows.values()].filter(value => value.page === row.page && value.body === row.body);
        const diagnostic = { owner: null, expectedRevision: null, contentHash: null, localContentHash: null,
          localRecoveryIdentityHash: null, localMatches: false, receipts: [], reasonCode: "invalid_body" };
        try {
          const input = parseBody(row.body); const actualOwner = owner ?? input.session?.owner;
          assert(Number.isSafeInteger(actualOwner) && actualOwner > 0, "invalid diagnostic owner");
          diagnostic.owner = actualOwner; diagnostic.expectedRevision = input.expectedRevision;
          const content = normalized(input.session, actualOwner); diagnostic.contentHash = sha(content);
          if (Array.isArray(receipts)) diagnostic.receipts = receipts.filter(receipt => Number(receipt.user_id) === actualOwner)
            .map(receipt => ({ revision: Number(receipt.revision), contentHash: sha(normalized(receipt.payload, actualOwner)) }));
          diagnostic.reasonCode = calls.length !== 1 || requests.length !== 1 ? "missing_or_ambiguous_native"
            : call.keepalive !== true || call.leaving !== true ? "not_pagehide_keepalive" : "invalid_local";
          if (call) {
            const local = JSON.parse(call.local); const localContent = normalized(local, actualOwner);
            diagnostic.localContentHash = sha(localContent); diagnostic.localRecoveryIdentityHash = sha(recoveryIdentity(local, actualOwner));
            diagnostic.localMatches = localContent === content;
            if (call.keepalive === true && call.leaving === true) diagnostic.reasonCode = !diagnostic.localMatches ? "local_mismatch"
              : !abort(row.failure) ? "not_failed_abort" : !Array.isArray(receipts) ? "receipts_not_observed"
                : diagnostic.receipts.some(receipt => receipt.revision === input.expectedRevision + 1 && receipt.contentHash === sha(content)) ? "exact_receipt_observed"
                  : diagnostic.receipts.some(receipt => receipt.contentHash === sha(content)) ? "wrong_revision"
                    : diagnostic.receipts.some(receipt => receipt.revision === input.expectedRevision + 1) ? "content_mismatch" : "missing_receipt";
          }
        } catch { /* Diagnostics never grant evidence or hide malformed observations. */ }
        return { id: row.id, context: row.label, path: PATH,
          bytes: typeof row.body === "string" ? Buffer.byteLength(row.body) : null,
          bodyHash: typeof row.body === "string" ? sha(row.body) : null,
          nativeMatch: Boolean(call), nativeCardinality: calls.length, requestCardinality: requests.length,
          documentHash: call ? sha(call.documentId) : null, keepalive: call?.keepalive === true, pagehide: call?.leaving === true,
          ...diagnostic, failure: abort(row.failure) ? row.failure : row.failure ? "unrecognized_failure" : null,
          proof: readStudioSessionProof(confirmed.get(row.request)) ? confirmed.get(row.request) : null };
      });
    },
    async install(context) {
      await context.exposeBinding("__auroraStudioSessionEvidence", ({ page, frame }, event) => {
        if (page && frame === page.mainFrame()) api.observeNative(page, event);
      });
      await context.addInitScript(({ origin, path, maxBytes, storagePrefix }) => {
        if (location.origin !== origin) return;
        const documentId = crypto.randomUUID(); let leaving = false; let count = 0;
        const send = event => { void window.__auroraStudioSessionEvidence({ ...event, documentId }).catch(() => {}); };
        send({ kind: "document" });
        const nativeGetItem = Storage.prototype.getItem;
        const nativeSetItem = Storage.prototype.setItem;
        let readCount = 0;
        Storage.prototype.getItem = function (...args) {
          const value = Reflect.apply(nativeGetItem, this, args);
          try {
            const key = args[0];
            if (this === localStorage && typeof key === "string" && key.startsWith(storagePrefix)
              && /^\d+$/u.test(key.slice(storagePrefix.length)) && typeof value === "string"
              && new Blob([value]).size <= maxBytes && readCount < 512) {
              const owner = Number(key.slice(storagePrefix.length));
              if (Number.isSafeInteger(owner) && owner > 0) { readCount += 1; send({ kind: "read", owner, raw: value }); }
            }
          } catch { /* Preserve the original Storage return and failure semantics. */ }
          return value;
        };
        let writeCount = 0;
        Storage.prototype.setItem = function (...args) {
          const result = Reflect.apply(nativeSetItem, this, args);
          try {
            const [key, raw] = args;
            if (leaving && this === localStorage && typeof key === "string" && key.startsWith(storagePrefix)
              && /^\d+$/u.test(key.slice(storagePrefix.length)) && typeof raw === "string"
              && new Blob([raw]).size <= maxBytes && writeCount < 128) {
              const owner = Number(key.slice(storagePrefix.length));
              if (Number.isSafeInteger(owner) && owner > 0) { writeCount += 1; send({ kind: "write", owner, raw, leaving }); }
            }
          } catch { /* Only successful exact native storage writes can become checkpoints. */ }
          return result;
        };
        addEventListener("pagehide", () => { leaving = true; });
        const original = fetch;
        window.fetch = function (input, init) {
          try {
            const url = new URL(input instanceof Request ? input.url : String(input), location.href);
            const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
            if (method === "PUT" && url.origin === origin && url.pathname === path && !url.search
              && typeof init?.body === "string" && new Blob([init.body]).size <= maxBytes && count < 128) {
              const owner = JSON.parse(init.body)?.session?.owner;
              if (Number.isSafeInteger(owner) && owner > 0) {
                const local = localStorage.getItem(storagePrefix + owner);
                if (typeof local === "string" && new Blob([local]).size <= maxBytes) {
                  count += 1;
                  send({ kind: "put", body: init.body, local, keepalive: init.keepalive === true, leaving });
                }
              }
            }
          } catch { /* Observation cannot change the native call or its result. Missing evidence fails closed. */ }
          return Reflect.apply(original, this, [input, init]);
        };
      }, { origin, path: PATH, maxBytes: MAX_BYTES, storagePrefix });
    },
  };
  return api;
}
