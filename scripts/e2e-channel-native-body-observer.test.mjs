import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { classifyCompletedChannelNotificationRead, installChannelNativeBodyObserver } from "./e2e-channel-native-body-observer.mjs";
import { classifyChannelOnboardingCancellation } from "./e2e-channel-onboarding-coverage.mjs";

const path = "/api/project-notifications";
const request = { id: 1, documentId: "document-1", firstParty: true, type: "fetch", method: "GET", path,
  status: 200, contentType: "application/json", failure: "net::ERR_ABORTED" };
const proof = { requestId: 1, documentId: "document-1", unambiguous: true, bodyDone: true, jsonValid: true,
  cancelled: false, overflow: false, error: null, status: 200, contentType: "application/json", bytes: 155 };

describe("completed native notifications read is an exact contract", () => {
  it("requires the same document/request and accepts only native successful EOF with valid bounded JSON", () => {
    expect(classifyChannelOnboardingCancellation(request, { nativeBody: proof })).toBe("completed_native_notifications_read");
    expect(classifyChannelOnboardingCancellation(request)).toBeNull();
  });
  it.each([{ method: "POST" }, { path: "/api/channels" }, { status: 503 }, { status: undefined },
    { failure: "net::ERR_CONNECTION_RESET" }, { failure: "NS_BINDING_ABORTED" }, { contentType: "text/html" },
    { firstParty: false }, { type: "document" }, { id: 2 }, { documentId: null }, { documentId: "old-document" }])("retains unmatched transport %j", (delta) => {
    expect(classifyCompletedChannelNotificationRead({ ...request, ...delta }, proof)).toBeNull();
  });
  it.each([{ unambiguous: false }, { bodyDone: false }, { jsonValid: false }, { cancelled: true }, { overflow: true },
    { error: "TypeError" }, { bytes: 0 }, { bytes: 65_537 }, { bytes: 1.5 }, { status: 204 }, { contentType: "text/plain" },
    { requestId: 2 }, { documentId: "other-document" }])("retains insufficient native proof %j", (delta) => {
    expect(classifyCompletedChannelNotificationRead(request, { ...proof, ...delta })).toBeNull();
  });
});

async function fixture(response = new Response('{"notifications":[]}', { headers: { "content-type": "application/json" } })) {
  const base = "https://127.0.0.1:63345"; const url = base + path + "?private=QUERY_CANARY";
  const frame = {}; const page = { mainFrame: () => frame };
  const scope = { URL, Request, Response, Uint8Array, TextDecoder, crypto: webcrypto, location: new URL(base),
    Date, performance, fetch: async () => response };
  scope.window = scope;
  const context = {
    exposeBinding: async (name, fn) => { scope[name] = (event) => Promise.resolve(fn({ page, frame }, event)); },
    addInitScript: async (fn, args) => { scope.__args = args; vm.runInNewContext(`(${fn.toString()})(__args)`, scope); },
  };
  page.evaluate = async (fn) => vm.runInNewContext(`(${fn.toString()})()`, scope);
  const observer = await installChannelNativeBodyObserver(context, { baseUrl: base });
  const row = { ...request, documentId: observer.documentFor(page) };
  const networkRequest = { url: () => url, frame: () => frame };
  observer.trackRequest(networkRequest, row, page);
  const read = async () => {
    const returned = await scope.fetch(url);
    const reader = returned.body.getReader(); const chunks = [];
    while (true) { const chunk = await reader.read(); if (chunk.done) break; chunks.push(chunk.value); }
    reader.releaseLock(); await observer.flush(page);
    return { returned, chunks };
  };
  return { observer, page, frame, row, scope, url, response, networkRequest, read };
}

describe("native observer does not replace app transport or persist body content", () => {
  it("keeps the native response/bytes and records only complete JSON metadata", async () => {
    const f = await fixture(); const body = f.response.body;
    const { returned, chunks } = await f.read();
    expect(returned).toBe(f.response); expect(returned.body).toBe(body);
    expect(new TextDecoder().decode(chunks[0])).toBe('{"notifications":[]}');
    const match = f.observer.match(f.row);
    expect(classifyChannelOnboardingCancellation(f.row, { nativeBody: match })).toBe("completed_native_notifications_read");
    expect(match).toMatchObject({ bodyDone: true, jsonValid: true, bytes: 20, cancelled: false, overflow: false });
    const evidence = JSON.stringify(f.observer.snapshot());
    expect(evidence).not.toContain("QUERY_CANARY"); expect(evidence).not.toContain('"notifications":[]');
    expect(evidence).not.toContain("https:"); expect(evidence).not.toContain("chunks");
  });
  it.each([["malformed", "not JSON"], ["excessive", '"' + "a".repeat(65_536) + '"']])("retains %s bodies", async (_name, body) => {
    const f = await fixture(new Response(body, { headers: { "content-type": "application/json" } }));
    const { chunks } = await f.read();
    expect(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)).toBe(new TextEncoder().encode(body).byteLength);
    expect(classifyChannelOnboardingCancellation(f.row, { nativeBody: f.observer.match(f.row) })).toBeNull();
  });
  it("does not infer EOF from a complete-looking chunk or cancel the caller to obtain proof", async () => {
    let cancelled = false;
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"ok":true}')); }, cancel() { cancelled = true; } });
    const f = await fixture(new Response(body, { headers: { "content-type": "application/json" } }));
    const response = await f.scope.fetch(f.url); const reader = response.body.getReader();
    expect((await reader.read()).done).toBe(false); await f.observer.flush(f.page);
    expect(f.observer.match(f.row)).toBeNull(); expect(cancelled).toBe(false);
    await reader.cancel(); await f.observer.flush(f.page);
    expect(f.observer.match(f.row)).toMatchObject({ bodyDone: false, cancelled: true, jsonValid: false });
    expect(classifyChannelOnboardingCancellation(f.row, { nativeBody: f.observer.match(f.row) })).toBeNull();
  });
  it("retains native reader failure without changing its error", async () => {
    const error = new TypeError("native read failure");
    const f = await fixture(new Response(new ReadableStream({ start(controller) { controller.error(error); } }), { headers: { "content-type": "application/json" } }));
    await expect(f.read()).rejects.toBe(error); await f.observer.flush(f.page);
    expect(f.observer.match(f.row)).toMatchObject({ bodyDone: false, error: "TypeError", jsonValid: false });
  });
  it("does not persist arbitrary native error names", async () => {
    const error = new Error("private native message"); error.name = "PRIVATE_ERROR_NAME_CANARY";
    const f = await fixture(new Response(new ReadableStream({ start(controller) { controller.error(error); } }), { headers: { "content-type": "application/json" } }));
    await expect(f.read()).rejects.toBe(error); await f.observer.flush(f.page);
    expect(f.observer.match(f.row)).toMatchObject({ bodyDone: false, error: "read_error" });
    expect(JSON.stringify(f.observer.snapshot())).not.toContain("PRIVATE_ERROR_NAME_CANARY");
    expect(JSON.stringify(f.observer.snapshot())).not.toContain("private native message");
  });
  it("does not associate two same-document browser requests with one native caller", async () => {
    const f = await fixture(); await f.read();
    f.observer.trackRequest(f.networkRequest, { ...f.row, id: 2 }, f.page);
    expect(f.observer.match(f.row)).toBeNull();
  });
  it("does not associate two native callers with one browser request", async () => {
    const f = await fixture(); await f.read(); await f.scope.fetch(f.url); await f.observer.flush(f.page);
    expect(f.observer.match(f.row)).toBeNull();
  });
  it("does not accept another document's completion", async () => {
    const f = await fixture(); await f.read(); f.row.documentId = "later-document";
    expect(f.observer.match(f.row)).toBeNull();
  });
  it.each([["POST", path], ["GET", "/api/channels"], ["GET", "/api/project-notifications/read-all"]])("does not instrument %s %s", async (method, otherPath) => {
    const f = await fixture(); const nativeGetReader = f.response.body.getReader;
    const response = await f.scope.fetch(new URL(otherPath, f.url).href, { method });
    expect(response).toBe(f.response); expect(response.body.getReader).toBe(nativeGetReader);
    expect(f.observer.snapshot()).toEqual([]);
  });
  it("delegates malformed destinations to native fetch without adding a synchronous parsing error", async () => {
    const f = await fixture();
    expect(await f.scope.fetch("http://%")).toBe(f.response);
    expect(f.observer.snapshot()).toEqual([]);
  });
});


describe("N53 native observer belongs to the explicit application origin", () => {
  const baseUrl = "https://127.0.0.1:63345";
  async function boot(href, crypto = {}) {
    const nativeFetch = async () => new Response("{}");
    const scope = { location: new URL(href), crypto, fetch: nativeFetch }; scope.window = scope;
    const bindings = [];
    const context = {
      exposeBinding: async (name) => { bindings.push(name); },
      addInitScript: async (fn, args) => { scope.__args = args; vm.runInNewContext(`(${fn.toString()})(__args)`, scope); },
    };
    const observer = await installChannelNativeBodyObserver(context, { baseUrl });
    return { scope, nativeFetch, observer, bindings };
  }
  it.each(["about:blank", "data:text/html,empty", "https://other.aurora.test/", "http://127.0.0.1:63345/", "https://127.0.0.1:63346/"])("does not touch native fetch/crypto on unowned %s", async (href) => {
    const f = await boot(href);
    expect(f.scope.fetch).toBe(f.nativeFetch);
    expect(f.scope.__flushChannelNativeBody).toBeUndefined();
    expect(f.observer.snapshot()).toEqual([]);
  });
  it("does not hide a missing required runtime API on the actual application origin", async () => {
    await expect(boot(baseUrl)).rejects.toThrow("crypto.randomUUID is not a function");
  });
});
