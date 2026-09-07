import { expect, it } from "vitest";
import { createStudioSessionEvidence, loadStudioSessionContract, readStudioSessionProof } from "./e2e-studio-session-evidence.mjs";

const contract = loadStudioSessionContract();
const baseUrl = "https://127.0.0.1:12345";
const payload = (owner = 1, draft = "text", id = "m1") => ({ version: 2, owner, savedAt: "2026-09-06T00:00:00Z",
  messages: [{ id, role: "ai", text: "synthetic partial", streaming: true }], draft, workspaceMode: "chat",
  generations: [[id, { cmd: "write", input: "synthetic", variant: 1, history: [], requestKey: "PRIVATE_KEY_CANARY" }]] });
function fixture(failure="net::ERR_ABORTED") {
  const page = {}; const evidence = createStudioSessionEvidence({ baseUrl, ...contract });
  const body = JSON.stringify({ expectedRevision: 4, session: payload() });
  const request = { url: () => baseUrl + "/api/studio/session", method: () => "PUT", postData: () => body,
    failure: () => ({ errorText: failure }) };
  const event = { kind: "put", documentId: "doc", body, local: JSON.stringify(payload()), keepalive: true, leaving: true };
  const receipt = { user_id: 1, revision: 5, payload: payload() };
  evidence.observeRequest(request, "main", page); evidence.observeFailure(request);
  return { evidence, page, request, body, event, receipt };
}

it("uses the current actual v2 parser and streaming recovery normalization", () => {
  expect(contract.storageKeyForOwner(3)).toBe("aurora:studio-chat:v2:user-3");
  const parsed = contract.normalizeSession(payload(), 1);
  expect(parsed.messages[0].streaming).not.toBe(true);
  expect(parsed.messages[0].interrupted).toBe(true);
  expect(Object.keys(contract.hashes)).toHaveLength(3);
});
it.each(["net::ERR_ABORTED", "Load request cancelled"])("ties persisted content to one actual failed PUT retaining %s", failure => {
  const f = fixture(failure); f.evidence.observeNative(f.page, f.event);
  const proof = f.evidence.confirmPersisted(f.request, { owner: 1, receipts: [f.receipt] });
  expect(proof.reason).toBe("persisted_studio_snapshot");
  expect(readStudioSessionProof(proof).request).toBe(f.request);
  expect(readStudioSessionProof({ ...proof })).toBeNull();
  expect(f.evidence.snapshot()[0].failure).toBe(failure);
  expect(JSON.stringify(f.evidence.snapshot())).not.toContain("PRIVATE_KEY_CANARY");
  expect(JSON.stringify(f.evidence.snapshot())).not.toContain("synthetic");
});
it.each(["no-native", "wrong-page", "no-keepalive", "no-pagehide", "wrong-body", "wrong-local", "wrong-owner", "wrong-revision", "no-receipt", "subset-only", "duplicate-native", "duplicate-request", "not-abort", "foreign-request"])("%s cannot prove a Studio save", kind => {
  const f = fixture();
  if (kind === "no-keepalive") f.event.keepalive = false;
  if (kind === "no-pagehide") f.event.leaving = false;
  if (kind === "wrong-body") f.event.body = f.body + " ";
  if (kind === "wrong-local") f.event.local = JSON.stringify(payload(1, "other"));
  if (kind !== "no-native") f.evidence.observeNative(kind === "wrong-page" ? {} : f.page, f.event);
  if (kind === "wrong-owner") f.receipt.user_id = 2;
  if (kind === "wrong-revision") f.receipt.revision = 6;
  if (kind === "subset-only") f.receipt.payload.messages.push({ id: "new", role: "user", text: "later" });
  if (kind === "duplicate-native") f.evidence.observeNative(f.page, f.event);
  if (kind === "duplicate-request") f.evidence.observeRequest({ ...f.request }, "main", f.page);
  if (kind === "not-abort") { f.request.failure = () => ({ errorText: "net::ERR_CONNECTION_RESET" }); f.evidence.observeFailure(f.request); }
  expect(() => f.evidence.confirmPersisted(kind === "foreign-request" ? { ...f.request } : f.request,
    { owner: 1, receipts: kind === "no-receipt" ? [] : [f.receipt] })).toThrow();
  expect(f.evidence.proofs()).toEqual([]);
});
it.each(["native", "request"])("a late duplicate %s invalidates an already minted certificate", kind => {
  const f = fixture(); f.evidence.observeNative(f.page, f.event);
  const proof = f.evidence.confirmPersisted(f.request, { owner: 1, receipts: [f.receipt] });
  if (kind === "native") f.evidence.observeNative(f.page, f.event);
  else f.evidence.observeRequest({ ...f.request }, "main", f.page);
  expect(readStudioSessionProof(proof)).toBeNull(); expect(f.evidence.proofs()).toEqual([]);
});
it("finds the exact earlier CAS receipt when later snapshots supersede it", () => {
  const f = fixture(); f.evidence.observeNative(f.page, f.event);
  const receipts = [f.receipt, { user_id: 1, revision: 6, payload: payload(1, "newer") }];
  expect(f.evidence.confirmPersisted(f.request, { owner: 1, receipts }).revision).toBe(5);
});
it("preserves exact empty draft intent and never accepts the old nonempty receipt", () => {
  const f = fixture(); const empty = { ...payload(1, ""), localDraftPending: true, localSnapshotId: "synthetic-id" };
  f.request.postData = () => JSON.stringify({ expectedRevision: 4, session: payload(1, "") });
  const request = { ...f.request }; f.evidence.observeRequest(request, "main", f.page); f.evidence.observeFailure(request);
  f.evidence.observeNative(f.page, { ...f.event, body: request.postData(), local: JSON.stringify(empty) });
  expect(() => f.evidence.confirmPersisted(request, { owner: 1, receipts: [f.receipt] })).toThrow();
  expect(f.evidence.confirmPersisted(request, { owner: 1, receipts: [{ ...f.receipt, payload: payload(1, "") }] }).revision).toBe(5);
});
it("independent local checkpoint rejects changed, foreign, and missing recovery", async () => {
  let raw = JSON.stringify(payload());
  const page = { evaluate: async () => raw }; const evidence = createStudioSessionEvidence({ baseUrl, ...contract });
  evidence.observeNative(page, { kind: "document", documentId: "old" });
  const checkpoint = await evidence.checkpoint(page, { owner: 1 });
  await expect(evidence.assertRestored(checkpoint, page, { owner: 1 })).rejects.toThrow();
  evidence.observeNative(page, { kind: "document", documentId: "new" });
  evidence.observeNative(page, { kind: "read", documentId: "new", owner: 1, raw });
  await evidence.assertRestored(checkpoint, page, { owner: 1 });
  expect(evidence.recoverySnapshot()).toHaveLength(1);
  expect(JSON.stringify(evidence.recoverySnapshot())).not.toContain("PRIVATE_KEY_CANARY");
  evidence.assertCheckpointPersisted(checkpoint, { owner: 1, receipts: [{ user_id: 1, revision: 5, payload: payload() }] });
  await expect(evidence.assertRestored(checkpoint, {}, { owner: 1 })).rejects.toThrow();
  await expect(evidence.assertRestored(checkpoint, page, { owner: 2 })).rejects.toThrow();
  raw = JSON.stringify(payload(1, "changed"));
  // New AI messages may be written after restoration; the actual initial read
  // remains the evidence. A later unrelated document cannot borrow that read.
  await evidence.assertRestored(checkpoint, page, { owner: 1 });
  evidence.observeNative(page, { kind: "document", documentId: "unrelated" });
  evidence.observeNative(page, { kind: "read", documentId: "unrelated", owner: 1, raw });
  await expect(evidence.assertRestored(checkpoint, page, { owner: 1 })).rejects.toThrow();
  raw = null; await expect(evidence.checkpoint(page, { owner: 1 })).rejects.toThrow();
});
it.each(["wrong-owner", "other-page", "old-document", "no-read", "contains-only"])("restoration %s is not an exact native recovery read", async kind => {
  const raw = JSON.stringify(payload()); const page = { evaluate: async () => raw };
  const evidence = createStudioSessionEvidence({ baseUrl, ...contract });
  evidence.observeNative(page, { kind: "document", documentId: "old" });
  const checkpoint = await evidence.checkpoint(page, { owner: 1 });
  evidence.observeNative(page, { kind: "document", documentId: "new" });
  const value = payload(); if (kind === "contains-only") value.messages.push({ id: "later", role: "user", text: "later" });
  if (kind !== "no-read") evidence.observeNative(kind === "other-page" ? {} : page, { kind: "read",
    documentId: kind === "old-document" ? "old" : "new", owner: kind === "wrong-owner" ? 2 : 1, raw: JSON.stringify(value) });
  await expect(evidence.assertRestored(checkpoint, page, { owner: 1 })).rejects.toThrow();
});
it("captures the new generated result from the actual pagehide invocation instead of a stale pre-button snapshot", async () => {
  const f = fixture(); f.evidence.observeNative(f.page, f.event);
  const checkpoint = f.evidence.checkpointForRequest(f.request, { owner: 1 });
  f.evidence.observeNative(f.page, { kind: "document", documentId: "returned" });
  f.evidence.observeNative(f.page, { kind: "read", documentId: "returned", owner: 1, raw: f.event.local });
  await f.evidence.assertRestored(checkpoint, f.page, { owner: 1 });
  f.evidence.assertCheckpointPersisted(checkpoint, { owner: 1, receipts: [f.receipt] });
});
it.each(["unknown-request", "owner", "duplicate", "local-mismatch", "not-pagehide"])("request checkpoint %s fails closed", kind => {
  const f = fixture();
  if (kind === "local-mismatch") f.event.local = JSON.stringify(payload(1, "old pre-button draft"));
  if (kind === "not-pagehide") f.event.leaving = false;
  f.evidence.observeNative(f.page, f.event);
  if (kind === "duplicate") f.evidence.observeNative(f.page, f.event);
  expect(() => f.evidence.checkpointForRequest(kind === "unknown-request" ? { ...f.request } : f.request,
    { owner: kind === "owner" ? 2 : 1 })).toThrow();
});
it.each(["flag-lost", "id-lost", "id-changed"])("empty draft recovery rejects %s despite equal server-normalized content", async kind => {
  const value = { ...payload(1, ""), localDraftPending: true, localSnapshotId: "11111111-1111-4111-8111-111111111111" };
  const page = { evaluate: async () => JSON.stringify(value) };
  const evidence = createStudioSessionEvidence({ baseUrl, ...contract });
  evidence.observeNative(page, { kind: "document", documentId: "old" });
  const checkpoint = await evidence.checkpoint(page, { owner: 1 });
  const actual = { ...value };
  if (kind === "flag-lost") delete actual.localDraftPending;
  if (kind === "id-lost") delete actual.localSnapshotId;
  if (kind === "id-changed") actual.localSnapshotId = "22222222-2222-4222-8222-222222222222";
  expect(contract.normalizeSession(actual, 1)).toEqual(contract.normalizeSession(value, 1));
  evidence.observeNative(page, { kind: "document", documentId: "new" });
  evidence.observeNative(page, { kind: "read", documentId: "new", owner: 1, raw: JSON.stringify(actual) });
  await expect(evidence.assertRestored(checkpoint, page, { owner: 1 })).rejects.toThrow();
  expect(JSON.stringify(evidence.recoverySnapshot())).not.toContain("11111111");
  evidence.observeNative(page, { kind: "read", documentId: "new", owner: 1, raw: JSON.stringify(value) });
  await evidence.assertRestored(checkpoint, page, { owner: 1 });
});
it.each(["valid-no-put", "wrong-owner", "wrong-page", "no-pagehide", "duplicate", "wrong-result", "wrong-text"])("native pagehide storage checkpoint %s", async kind => {
  const f = fixture(); const value = payload(); value.messages[0].generationResultId = 9;
  const write = { kind: "write", documentId: "old", owner: kind === "wrong-owner" ? 2 : 1,
    raw: JSON.stringify(value), leaving: kind !== "no-pagehide" };
  f.evidence.observeNative(kind === "wrong-page" ? {} : f.page, write);
  if (kind === "duplicate") f.evidence.observeNative(f.page, write);
  const capture = () => f.evidence.checkpointForPageHide(f.page, { owner: 1,
    generationResultId: kind === "wrong-result" ? 10 : 9, text: kind === "wrong-text" ? "different" : value.messages[0].text });
  if (kind !== "valid-no-put") expect(capture).toThrow();
  else {
    const checkpoint = capture();
    f.evidence.observeNative(f.page, { kind: "document", documentId: "returned" });
    f.evidence.observeNative(f.page, { kind: "read", documentId: "returned", owner: 1, raw: JSON.stringify(value) });
    await f.evidence.assertRestored(checkpoint, f.page, { owner: 1 });
    f.evidence.assertCheckpointPersisted(checkpoint, { owner: 1, receipts: [{ user_id: 1, revision: 5, payload: value }] });
    expect(f.evidence.proofs()).toEqual([]); // No request is invented or forgiven.
  }
});
it.each(["exact", "append", "missing-duplicate", "changed"])("rendered history %s respects exact text multiplicity", async kind => {
  const value = payload(); value.messages = [{ id: "a", role: "user", text: "same text" }, { id: "b", role: "ai", text: "same text" }];
  const rendered = kind === "missing-duplicate" ? ["same text"] : kind === "changed" ? ["same text", "changed"] : ["same text", "same text", ...(kind === "append" ? ["new AI message"] : [])];
  const page = { evaluate: async () => JSON.stringify(value), getByRole: (role, options) => {
    expect(role).toBe("region"); expect(options).toEqual({ name: "Диалог с ИИ", exact: true });
    return { locator: selector => { expect(selector).toBe("p.whitespace-pre-wrap"); return { allTextContents: async () => rendered }; } };
  } };
  const evidence = createStudioSessionEvidence({ baseUrl, ...contract }); evidence.observeNative(page, { kind: "document", documentId: "old" });
  const checkpoint = await evidence.checkpoint(page, { owner: 1 });
  if (["exact", "append"].includes(kind)) expect((await evidence.assertRenderedMessages(checkpoint, page)).expectedMessages).toBe(2);
  else await expect(evidence.assertRenderedMessages(checkpoint, page)).rejects.toThrow();
});

function departureFixture() {
  const value = payload(); value.messages.unshift({ id: "stable", role: "user", text: "known prior history" });
  value.localDraftPending = true; value.localSnapshotId = "11111111-1111-4111-8111-111111111111";
  const page = { evaluate: async () => JSON.stringify(value) };
  const evidence = createStudioSessionEvidence({ baseUrl, ...contract });
  evidence.observeNative(page, { kind: "document", documentId: "old" });
  return { value, page, evidence };
}
it.each(["stream-progress", "new-message", "same"])("departure ticket %s captures exact later natural snapshot", async kind => {
  const f = departureFixture();
  const ticket = await f.evidence.departureTicket(f.page, { owner: 1, requestKey: "PRIVATE_KEY_CANARY" });
  const next = structuredClone(f.value);
  if (kind === "stream-progress") next.messages[1].text += " subsequent stream fragment";
  if (kind === "new-message") next.messages.push({ id: "later", role: "ai", text: "new terminal message" });
  f.evidence.observeNative(f.page, { kind: "write", owner: 1, documentId: "old", raw: JSON.stringify(next), leaving: true });
  f.evidence.observeNative(f.page, { kind: "document", documentId: "new" });
  f.evidence.observeNative(f.page, { kind: "read", owner: 1, documentId: "new", raw: JSON.stringify(next) });
  const checkpoint = f.evidence.checkpointForDeparture(ticket);
  await f.evidence.assertRestored(checkpoint, f.page, { owner: 1 });
  f.evidence.assertCheckpointPersisted(checkpoint, { owner: 1, receipts: [{ user_id: 1, revision: 5, payload: next }] });
  if (kind !== "same") expect(() => f.evidence.assertCheckpointPersisted(checkpoint, { owner: 1,
    receipts: [{ user_id: 1, revision: 5, payload: f.value }] })).toThrow();
  expect(JSON.stringify(f.evidence.departureSnapshot())).not.toContain("PRIVATE_KEY_CANARY");
  expect(JSON.stringify(f.evidence.departureSnapshot())).not.toContain("known prior history");
});
it.each(["lost-stable", "changed-stable", "lost-stream", "changed-role", "wrong-key", "lost-generation", "changed-generation", "draft", "workspace", "pending-flag", "pending-id", "wrong-page", "wrong-owner", "wrong-doc", "no-pagehide", "no-write", "duplicate-write", "before-ticket", "duplicate-message"])("departure %s fails closed independently of matching restoration", async kind => {
  const f = departureFixture(); const next = structuredClone(f.value);
  if (kind === "before-ticket") f.evidence.observeNative(f.page, { kind: "write", owner: 1, documentId: "old", raw: JSON.stringify(next), leaving: true });
  const ticket = await f.evidence.departureTicket(f.page, { owner: 1, requestKey: "PRIVATE_KEY_CANARY" });
  if (kind === "lost-stable") next.messages.shift();
  if (kind === "changed-stable") next.messages[0].text = "corrupted prior history";
  if (kind === "lost-stream") next.messages.pop();
  if (kind === "changed-role") next.messages[1].role = "user";
  if (kind === "wrong-key") next.generations[0][1].requestKey = "foreign";
  if (kind === "lost-generation") next.generations = [];
  if (kind === "changed-generation") next.generations[0][1].input = "different operation";
  if (kind === "draft") next.draft = "unrelated draft";
  if (kind === "workspace") next.workspaceMode = "studio";
  if (kind === "pending-flag") delete next.localDraftPending;
  if (kind === "pending-id") next.localSnapshotId = "22222222-2222-4222-8222-222222222222";
  if (kind === "duplicate-message") next.messages.push(structuredClone(next.messages[0]));
  const event = { kind: "write", owner: kind === "wrong-owner" ? 2 : 1, documentId: kind === "wrong-doc" ? "foreign" : "old", raw: JSON.stringify(next), leaving: kind !== "no-pagehide" };
  if (!["no-write", "before-ticket"].includes(kind)) f.evidence.observeNative(kind === "wrong-page" ? {} : f.page, event);
  if (kind === "duplicate-write") f.evidence.observeNative(f.page, event);
  f.evidence.observeNative(f.page, { kind: "document", documentId: "new" });
  f.evidence.observeNative(f.page, { kind: "read", owner: 1, documentId: "new", raw: JSON.stringify(next) });
  expect(() => f.evidence.checkpointForDeparture(ticket)).toThrow();
  expect(f.evidence.proofs()).toEqual([]);
});
it("does not mint departure tickets for a missing/foreign key or duplicate message identity", async () => {
  const f = departureFixture();
  await expect(f.evidence.departureTicket(f.page, { owner: 1, requestKey: "wrong" })).rejects.toThrow();
  await expect(f.evidence.departureTicket(f.page, { owner: 2, requestKey: "PRIVATE_KEY_CANARY" })).rejects.toThrow();
  f.value.messages.push(structuredClone(f.value.messages[1]));
  f.value.generations.push([f.value.messages[1].id, structuredClone(f.value.generations[0][1])]);
  await expect(f.evidence.departureTicket(f.page, { owner: 1, requestKey: "PRIVATE_KEY_CANARY" })).rejects.toThrow();
  expect(() => f.evidence.checkpointForDeparture({})).toThrow();
});
it("safe persistence diagnostics show exact missing revision or content without granting a proof", () => {
  const f = fixture(); f.evidence.observeNative(f.page, f.event);
  const missing = f.evidence.snapshot({ owner: 1, receipts: [] })[0];
  expect(missing.expectedRevision).toBe(4); expect(missing.keepalive).toBe(true); expect(missing.pagehide).toBe(true);
  expect(missing.localMatches).toBe(true); expect(missing.nativeCardinality).toBe(1); expect(missing.requestCardinality).toBe(1);
  expect(missing.reasonCode).toBe("missing_receipt");
  expect(f.evidence.snapshot({ owner: 1, receipts: [{ ...f.receipt, revision: 6 }] })[0].reasonCode).toBe("wrong_revision");
  expect(f.evidence.snapshot({ owner: 1, receipts: [{ ...f.receipt, payload: payload(1, "different") }] })[0].reasonCode).toBe("content_mismatch");
  const exact = f.evidence.snapshot({ owner: 1, receipts: [f.receipt] })[0];
  expect(exact.reasonCode).toBe("exact_receipt_observed"); expect(exact.proof).toBeNull(); expect(f.evidence.proofs()).toEqual([]);
  expect(exact.receipts).toEqual([{ revision: 5, contentHash: expect.any(String) }]);
  expect(JSON.stringify(exact)).not.toContain("PRIVATE_KEY_CANARY"); expect(JSON.stringify(exact)).not.toContain("synthetic");
});
it.each(["malformed", "private-owner", "no-native", "duplicate", "non-pagehide"])("safe diagnostic %s remains non-authoritative", kind => {
  const f = fixture();
  if (kind === "malformed" || kind === "private-owner") {
    const body = kind === "malformed" ? "PRIVATE_MALFORMED_CANARY" : JSON.stringify({ expectedRevision: 4, session: { ...payload(), owner: "PRIVATE_OWNER_CANARY" } });
    const request = { ...f.request, postData: () => body };
    f.evidence.observeRequest(request, "main", f.page); f.evidence.observeFailure(request);
  } else if (kind !== "no-native") {
    f.evidence.observeNative(f.page, { ...f.event, leaving: kind !== "non-pagehide" });
    if (kind === "duplicate") f.evidence.observeNative(f.page, f.event);
  }
  const snapshots = f.evidence.snapshot({ receipts: [] });
  expect(snapshots.every(row => row.proof === null)).toBe(true); expect(f.evidence.proofs()).toEqual([]);
  expect(JSON.stringify(snapshots)).not.toContain("PRIVATE_"); expect(JSON.stringify(snapshots)).not.toContain("synthetic");
});
it("accepts legitimate separate replay messages that retain the same operation key", async () => {
  const f = departureFixture();
  f.value.messages.push({ id: "replayed", role: "ai", text: "Generation was cancelled; same-key replay is terminal." });
  f.value.generations.push(["replayed", structuredClone(f.value.generations[0][1])]);
  const ticket = await f.evidence.departureTicket(f.page, { owner: 1, requestKey: "PRIVATE_KEY_CANARY" });
  f.evidence.observeNative(f.page, { kind: "write", owner: 1, documentId: "old", raw: JSON.stringify(f.value), leaving: true });
  f.evidence.observeNative(f.page, { kind: "document", documentId: "returned" });
  f.evidence.observeNative(f.page, { kind: "read", owner: 1, documentId: "returned", raw: JSON.stringify(f.value) });
  const checkpoint = f.evidence.checkpointForDeparture(ticket);
  await f.evidence.assertRestored(checkpoint, f.page, { owner: 1 });
  f.evidence.assertCheckpointPersisted(checkpoint, { owner: 1, receipts: [{ user_id: 1, revision: 3, payload: f.value }] });
  expect(f.evidence.proofs()).toEqual([]);
});
it.each(["changed-key", "lost-generation", "lost-message", "changed-input"])("legal replay lineage still rejects %s even when another entry retains the expected key", async kind => {
  const f = departureFixture();
  f.value.messages.push({ id: "replayed", role: "ai", text: "Terminal replay for the same operation" });
  f.value.generations.push(["replayed", structuredClone(f.value.generations[0][1])]);
  const ticket = await f.evidence.departureTicket(f.page, { owner: 1, requestKey: "PRIVATE_KEY_CANARY" });
  const next = structuredClone(f.value);
  if (kind === "changed-key") next.generations[1][1].requestKey = "FOREIGN_KEY_CANARY";
  if (kind === "changed-input") next.generations[1][1].input = "foreign operation input";
  if (kind === "lost-generation") next.generations.pop();
  if (kind === "lost-message") next.messages.pop();
  f.evidence.observeNative(f.page, { kind: "write", owner: 1, documentId: "old", raw: JSON.stringify(next), leaving: true });
  expect(() => f.evidence.checkpointForDeparture(ticket)).toThrow();
  expect(f.evidence.proofs()).toEqual([]);
});
it("rejects duplicate generation-map IDs independently of unique message IDs", async () => {
  const f = departureFixture();
  f.value.generations.push([f.value.generations[0][0], { ...f.value.generations[0][1], input: "conflicting generation" }]);
  await expect(f.evidence.departureTicket(f.page, { owner: 1, requestKey: "PRIVATE_KEY_CANARY" })).rejects.toThrow(/generation identity/u);
});

const reverseObjectKeys = value => Array.isArray(value) ? value.map(reverseObjectKeys)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reverseObjectKeys(value[key])])) : value;
function validationFixture() {
  const value = payload(); value.messages[0].streaming = false;
  value.messages[0].aiValidation = { version: 1, status: "passed", requiresReview: false,
    provenance: { validatorVersion: "fact-ledger-v1", ledgerHash: "OWNED_LEDGER", checkedAt: "2026-09-06T00:00:00Z",
      coverage: "deterministic", semanticEntailment: "not_run", rulesRun: ["first", "second"], sourceIds: ["one", "two"] },
    blockerCodes: [], topicAlignment: { status: "passed", score: 0.99, topic: "owned topic" } };
  const page = { evaluate: async () => JSON.stringify(value) };
  const evidence = createStudioSessionEvidence({ baseUrl, ...contract });
  const body = JSON.stringify({ expectedRevision: 4, session: value });
  const request = { url: () => baseUrl + "/api/studio/session", method: () => "PUT", postData: () => body,
    failure: () => ({ errorText: "net::ERR_ABORTED" }) };
  evidence.observeRequest(request, "main", page); evidence.observeFailure(request);
  evidence.observeNative(page, { kind: "document", documentId: "old" });
  evidence.observeNative(page, { kind: "put", documentId: "old", body, local: JSON.stringify(value), keepalive: true, leaving: true });
  return { value, page, evidence, request };
}
it("canonical full CAS receipt equality ignores only object property order, including nested AI validation", () => {
  const f = validationFixture(); const reordered = reverseObjectKeys(f.value);
  expect(contract.normalizeSession(reordered, 1)).toEqual(contract.normalizeSession(f.value, 1));
  const proof = f.evidence.confirmPersisted(f.request, { owner: 1, receipts: [{ user_id: 1, revision: 5, payload: reordered }] });
  expect(readStudioSessionProof(proof).request).toBe(f.request);
  expect(f.evidence.snapshot({ owner: 1, receipts: [{ user_id: 1, revision: 5, payload: reordered }] })[0].reasonCode).toBe("exact_receipt_observed");
});
it("exact native restoration and full persisted checkpoints survive JSON object key reordering", async () => {
  const f = validationFixture(); const checkpoint = await f.evidence.checkpoint(f.page, { owner: 1 });
  const reordered = reverseObjectKeys(f.value);
  f.evidence.observeNative(f.page, { kind: "document", documentId: "returned" });
  f.evidence.observeNative(f.page, { kind: "read", owner: 1, documentId: "returned", raw: JSON.stringify(reordered) });
  await f.evidence.assertRestored(checkpoint, f.page, { owner: 1 });
  f.evidence.assertCheckpointPersisted(checkpoint, { owner: 1, receipts: [{ user_id: 1, revision: 5, payload: reordered }] });
});
it("departure stable message and full generation comparisons do not depend on nested object key order", async () => {
  const f = validationFixture(); const ticket = await f.evidence.departureTicket(f.page, { owner: 1, requestKey: "PRIVATE_KEY_CANARY" });
  const reordered = reverseObjectKeys(f.value);
  f.evidence.observeNative(f.page, { kind: "write", owner: 1, documentId: "old", raw: JSON.stringify(reordered), leaving: true });
  expect(f.evidence.checkpointForDeparture(ticket).owner).toBe(1);
});
it.each(["nested-value", "array-order", "missing-property", "value-type"])("full canonical JSON rejects a changed %s", kind => {
  const f = validationFixture(); const changed = reverseObjectKeys(f.value); const validation = changed.messages[0].aiValidation;
  if (kind === "nested-value") validation.topicAlignment.score = 0.98;
  if (kind === "array-order") validation.provenance.rulesRun.reverse();
  if (kind === "missing-property") delete validation.provenance.ledgerHash;
  if (kind === "value-type") validation.topicAlignment.score = "0.99";
  expect(() => f.evidence.confirmPersisted(f.request, { owner: 1, receipts: [{ user_id: 1, revision: 5, payload: changed }] })).toThrow();
  expect(f.evidence.proofs()).toEqual([]);
});
it("semantic canonicalization does not replace exact native request-body identity", () => {
  const f = validationFixture();
  const equivalentRequest = { ...f.request, postData: () => JSON.stringify(reverseObjectKeys(JSON.parse(f.request.postData()))) };
  f.evidence.observeRequest(equivalentRequest, "main", f.page); f.evidence.observeFailure(equivalentRequest);
  expect(() => f.evidence.confirmPersisted(equivalentRequest, { owner: 1,
    receipts: [{ user_id: 1, revision: 5, payload: reverseObjectKeys(f.value) }] })).toThrow();
  expect(f.evidence.proofs()).toEqual([]);
});
