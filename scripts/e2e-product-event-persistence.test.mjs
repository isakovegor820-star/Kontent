import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";
import { createMainRequestEvidence, readMainCancellationProof } from "./e2e-main-request-evidence.mjs";

function fixture(change = {}) {
  const now = Date.now(); const page = {}; const actorUserId = 7;
  const evidence = createMainRequestEvidence({ baseUrl: "https://localhost:12345", now: () => now, actorForPage: p => p === page ? actorUserId : null });
  const events = [0, 1].map(() => ({ eventId: randomUUID(), sectionId: "composer", featureId: "draft", action: "saved",
    stage: "completed", outcome: "success", occurredAt: new Date(now).toISOString(), safeContext: { source: "ui" } }));
  const request = { url: () => "https://localhost:12345/api/product-events", method: () => "POST", resourceType: () => "fetch",
    headers: () => ({ "content-type": "application/json", "x-aurora-project-id": "11" }), postData: () => JSON.stringify({ events }),
    failure: () => ({ errorText: "net::ERR_ABORTED" }), ...change };
  evidence.observeRequest(request, "main", page); evidence.observeFailure(request);
  const receipts = events.map((e, i) => ({ id: i + 1, event_id: e.eventId, project_id: 11, user_id: 7, section_id: e.sectionId,
    feature_id: e.featureId, action: e.action, stage: e.stage, outcome: e.outcome, duration_ms: null, error_code: null,
    request_id: randomUUID(), operation_id: null, session_id: null, occurred_at: new Date(now), safe_context: e.safeContext, important: false }));
  return { evidence, request, receipts, events, page, actorUserId };
}

it("a lost response is settled only by all exact committed event effects", () => {
  const f = fixture(); expect(f.evidence.reason(f.request)).toBeNull();
  expect(f.evidence.productEventReceiptScope(f.request)).toEqual({ actorUserId: 7, projectId: 11, eventIds: f.events.map(e => e.eventId) });
  f.evidence.confirmProductEventPersistence(f.request, { receipts: f.receipts });
  expect(f.evidence.reason(f.request)).toBe("durably_persisted_product_events");
  const proof = f.evidence.proofs()[0]; expect(readMainCancellationProof(proof).request).toBe(f.request);
  expect(readMainCancellationProof({ ...proof })).toBeNull();
  expect(f.evidence.snapshot()[0]).toMatchObject({ status: null, persistedProductEventCount: 2 });
  expect(JSON.stringify(f.evidence.snapshot())).not.toContain(f.events[0].eventId);
});
it.each(["missing", "duplicate", "actor", "project", "event", "action", "stage", "outcome", "time", "context", "duration", "error", "operation", "session", "important", "invalid-request-id"])("a %s receipt cannot prove the captured batch", kind => {
  const f = fixture(); const r = f.receipts[0];
  if (kind === "missing") f.receipts.pop();
  if (kind === "duplicate") f.receipts[1] = r;
  const fields = { actor: ["user_id", 8], project: ["project_id", 12], event: ["event_id", randomUUID()], action: ["action", "loaded"],
    stage: ["stage", "accepted"], outcome: ["outcome", "failure"], time: ["occurred_at", new Date(0)], context: ["safe_context", {}],
    duration: ["duration_ms", 1], error: ["error_code", "failed"], operation: ["operation_id", "other"], session: ["session_id", randomUUID()],
    important: ["important", true], "invalid-request-id": ["request_id", null] };
  if (fields[kind]) r[fields[kind][0]] = fields[kind][1];
  expect(() => f.evidence.confirmProductEventPersistence(f.request, { receipts: f.receipts })).toThrow();
  expect(f.evidence.reason(f.request)).toBeNull(); expect(f.evidence.proofs()).toEqual([]);
});
it.each(["network", "foreign", "method", "resource", "project", "body", "empty", "invalid-event", "oversize"])("%s request cannot borrow durable event evidence", kind => {
  const changes = { network: { failure: () => ({ errorText: "net::ERR_CONNECTION_RESET" }) }, foreign: { url: () => "https://foreign.invalid/api/product-events" },
    method: { method: () => "PUT" }, resource: { resourceType: () => "xhr" }, project: { headers: () => ({ "content-type": "application/json" }) },
    body: { postData: () => "invalid" }, empty: { postData: () => '{"events":[]}' }, "invalid-event": { postData: () => '{"events":[{}]}' },
    oversize: { postData: () => " ".repeat(65_537) } };
  const f = fixture(changes[kind]); expect(f.evidence.productEventReceiptScope(f.request)).toBeNull();
  expect(() => f.evidence.confirmProductEventPersistence(f.request, { receipts: f.receipts })).toThrow();
  expect(f.evidence.reason(f.request)).toBeNull();
});
it("unobserved requests, another actor and another batch retain uncertainty", () => {
  const f = fixture(); const other = { ...f.request };
  expect(() => f.evidence.confirmProductEventPersistence(other, { receipts: f.receipts })).toThrow();
  f.evidence.observeRequest(other, "unknown", {}); f.evidence.observeFailure(other);
  expect(f.evidence.productEventReceiptScope(other)).toBeNull();
  const second = fixture(); expect(() => second.evidence.confirmProductEventPersistence(second.request, { receipts: f.receipts })).toThrow();
});
it("post-capture request mutation cannot change the batch being proved", () => {
  const f = fixture(); f.request.postData = () => '{"events":[]}'; f.request.headers = () => ({});
  f.evidence.confirmProductEventPersistence(f.request, { receipts: f.receipts });
  expect(f.evidence.reason(f.request)).toBe("durably_persisted_product_events");
});
it("an observed server failure cannot be relabelled by a prior durable effect", () => {
  const f = fixture(); f.evidence.observeResponse({ request: () => f.request, status: () => 503, headers: () => ({}) });
  expect(f.evidence.productEventReceiptScope(f.request)).toBeNull();
  expect(() => f.evidence.confirmProductEventPersistence(f.request, { receipts: f.receipts })).toThrow();
  expect(f.evidence.reason(f.request)).toBeNull();
});
it.each([true, false])("the actual finalizer reads exact actor/project/event receipts and preserves unknowns: complete=%s", async complete => {
  const f = fixture(); let clock = 0; let reads = 0;
  const source = readFileSync(new URL("./test-e2e-real.mjs", import.meta.url), "utf8");
  const ast = ts.createSourceFile("main.mjs", source, ts.ScriptTarget.Latest, true);
  const actual = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "finalizeProductEventPersistence").getFullText(ast);
  const state = { mainRequestEvidence: f.evidence, mainFailedRequestIssues: new Map([[f.request, {}]]),
    Set, Promise, setTimeout, Date: { now: () => clock += 6_000 }, pool: { query: async (sql, values) => {
      expect(sql.trim()).toMatch(/^select /u); expect(sql).toContain("where user_id=$1 and project_id=$2 and event_id=any($3::uuid[])");
      expect(Array.from(values.slice(0, 2))).toEqual([7, 11]); expect(Array.from(values[2])).toEqual(f.events.map(e => e.eventId));
      reads++; return { rows: complete ? f.receipts : f.receipts.slice(0, 1) };
    } } };
  vm.createContext(state); vm.runInContext(actual + "\nglobalThis.finalize = finalizeProductEventPersistence;", state);
  await state.finalize(); expect(reads).toBe(1);
  expect(f.evidence.reason(f.request)).toBe(complete ? "durably_persisted_product_events" : null);
});
