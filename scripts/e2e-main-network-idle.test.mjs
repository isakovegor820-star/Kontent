import { expect, it } from "vitest";
import { createMainRequestEvidence } from "./e2e-main-request-evidence.mjs";
import { createMainNetworkIdleFixture, createEditorNetworkIdleFixture,
  createChannelNetworkIdleFixture, createZoomNetworkIdleFixture } from "./e2e-native-read-terminal.mjs";

function fixture(mode = "valid") {
  const baseUrl = "http://127.0.0.1:12345"; const page = {};
  const evidence = createMainRequestEvidence({ baseUrl });
  evidence.observeNative(page, { kind: "document", documentId: "doc" });
  const path = mode === "telemetry" ? "/api/product-events" : "/api/channels";
  const url = baseUrl + path;
  const request = { url: () => url, method: () => mode === "mutation" ? "POST" : "GET",
    resourceType: () => mode === "image" ? "image" : "fetch",
    headers: () => ({ "x-aurora-e2e-read-id": "read-1" }), timing: () => ({}), failure: () => null };
  const emit = (kind, at, extra = {}) => evidence.observeNative(page, { kind, at, id: 1, identity: "read-1",
    documentId: "doc", method: "GET", url, ...extra });
  emit("start", 1000); evidence.observeRequest(request, "reviewer", page);
  if (mode === "collision") emit("collision", 1001);
  if (mode === "duplicate-call") emit("start", 1001, { id: 2 });
  if (mode !== "no-abort") emit("abort", 1002);
  if (mode !== "pending") emit("failure", 1003, { callerAbort: mode !== "network" });
  if (mode === "body-started") emit("body-reader", 1004, { readerId: 1 });
  if (mode.startsWith("http-")) evidence.observeResponse({ request: () => request,
    status: () => Number(mode.slice(5)), headers: () => ({}) });
  const pending = new Set([request]);
  const wait = createMainNetworkIdleFixture({ evidence, page, pendingRequests: pending, timeoutMs: 70 });
  return { evidence, page, request, pending, wait };
}

it("actual first-party idle consumer accepts the exact caller-abort proof without inventing a transport terminal", async () => {
  const f = fixture();
  expect(f.evidence.reason(f.request)).toBe("native_caller_abort_without_transport_terminal");
  await expect(f.wait()).resolves.toBeUndefined();
  expect(f.pending.has(f.request)).toBe(true);
  expect(f.evidence.snapshot()[0]).toMatchObject({ status: null, failure: null, finishedAt: null, failedAt: null });
});

it.each(["pending", "no-abort", "network", "mutation", "image", "collision", "duplicate-call",
  "body-started", "http-200", "http-401", "http-500"])("idle still rejects %s without a valid terminal proof", async mode => {
  const f = fixture(mode);
  expect(f.evidence.reason(f.request)).toBeNull();
  await expect(f.wait()).rejects.toThrow(/first-party requests did not settle/u);
  expect(f.pending.has(f.request)).toBe(true);
});

it("rechecks the proof and blocks a retained request after a contradictory response", async () => {
  const f = fixture(); await expect(f.wait()).resolves.toBeUndefined();
  f.evidence.observeResponse({ request: () => f.request, status: () => 401, headers: () => ({}) });
  await expect(f.wait()).rejects.toThrow(/first-party requests did not settle/u);
});

it("one proved abort does not hide another pending request", async () => {
  const f = fixture(); const other = { ...f.request, url: () => "http://127.0.0.1:12345/api/posts" };
  f.pending.add(other);
  await expect(f.wait()).rejects.toThrow(/first-party requests did not settle/u);
});

it("preserves the existing opt-in product-event idle policy", async () => {
  const f = fixture("telemetry");
  f.evidence.observeResponse({ request: () => f.request, status: () => 200, headers: () => ({}) });
  await expect(f.wait()).resolves.toBeUndefined();
  await expect(f.wait({ includeProductEvents: true })).rejects.toThrow(/first-party requests did not settle/u);
});

it("preserves the continuous quiet-period requirement when a pending request arrives", async () => {
  const f = fixture(); const other = { ...f.request, url: () => "http://127.0.0.1:12345/api/posts" };
  const timer = setTimeout(() => f.pending.add(other), 10);
  try { await expect(f.wait({ idleMs: 50 })).rejects.toThrow(/first-party requests did not settle/u); }
  finally { clearTimeout(timer); }
});

function editorFixture(mode = "valid") {
  const f = fixture(mode); const row = { page: 0, method: "GET", path: "/api/channels" };
  const network = [row]; const requests = new Map([[f.request, row]]);
  return { ...f, row, network, requests,
    waitEditor: createEditorNetworkIdleFixture({ evidence: f.evidence, page: f.page, requests, network }) };
}
it("the actual editor idle consumer accepts the same exact proof and retains its diagnostic row", async () => {
  const f = editorFixture(); await expect(f.waitEditor()).resolves.toBeUndefined();
  expect(f.network).toEqual([f.row]); expect(f.row.finishedAt).toBeUndefined(); expect(f.row.failedAt).toBeUndefined();
});
it.each(["pending", "network", "collision", "http-401"])("editor idle still rejects %s", async mode => {
  const f = editorFixture(mode); await expect(f.waitEditor()).rejects.toThrow(/requests did not settle/u);
});
it("a proved abort does not hide an editor row without its exact Request mapping", async () => {
  const f = editorFixture(); f.requests.clear();
  await expect(f.waitEditor()).rejects.toThrow(/requests did not settle/u);
});
it("editor idle rechecks a proof during its continuous quiet interval", async () => {
  const f = editorFixture();
  const timer = setTimeout(() => f.evidence.observeResponse({ request: () => f.request, status: () => 401, headers: () => ({}) }), 30);
  try { await expect(f.waitEditor()).rejects.toThrow(/requests did not settle/u); }
  finally { clearTimeout(timer); }
});

for (const [name, create] of [["channel", createChannelNetworkIdleFixture], ["zoom", createZoomNetworkIdleFixture]]) {
  const consumer = mode => { const f = editorFixture(mode); return { ...f, idle: create({ evidence: f.evidence, requests: f.requests, network: f.network }) }; };
  it(`${name} idle accepts only the exact producer proof while retaining the raw row`, async () => {
    const f = consumer(); await expect(f.idle()).resolves.toBeUndefined();
    expect(f.network).toEqual([f.row]); expect(f.row.finishedAt).toBeUndefined(); expect(f.row.failedAt).toBeUndefined();
  });
  it.each(["pending", "network", "collision", "http-401"])(`${name} idle rejects %s`, async mode => {
    const f = consumer(mode); await expect(f.idle()).rejects.toThrow(/did not settle/u);
  });
  it(`${name} idle retains an unmapped row even if a native proof exists`, async () => {
    const f = consumer(); f.requests.clear(); await expect(f.idle()).rejects.toThrow(/did not settle/u);
  });
  it(`${name} idle rechecks a contradictory response during the quiet interval`, async () => {
    const f = consumer();
    const timer = setTimeout(() => f.evidence.observeResponse({ request: () => f.request, status: () => 401, headers: () => ({}) }), 30);
    try { await expect(f.idle()).rejects.toThrow(/did not settle/u); } finally { clearTimeout(timer); }
  });
}
