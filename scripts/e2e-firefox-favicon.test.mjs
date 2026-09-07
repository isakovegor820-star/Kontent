import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import { createMainRequestEvidence, readMainCancellationProof } from "./e2e-main-request-evidence.mjs";

const baseUrl = "https://localhost:12345";

async function fixture({ engine = "firefox", collocated = true } = {}) {
  const context = new EventEmitter();
  const session = new EventEmitter();
  const implementation = new WeakMap();
  const connection = collocated ? { toImpl: value => implementation.get(value) } : {};
  const frame = { page: () => page };
  const page = { _connection: connection, mainFrame: () => frame };
  const manager = { _session: session, _requests: new Map() };
  implementation.set(page, { delegate: { _networkManager: manager } });
  context.browser = () => ({ browserType: () => ({ name: () => engine }) });
  context.pages = () => [page];
  context.exposeBinding = async () => {};
  context.addInitScript = async () => {};
  const evidence = createMainRequestEvidence({ baseUrl });
  await evidence.install(context);
  const serverRequest = {};
  const request = ({ path = "/icon.svg", method = "GET", type = "image", target = page,
    redirected = false, navigation = false, headers = {}, failure = "NS_BINDING_ABORTED" } = {}) => {
    const value = { _connection: connection, url: () => baseUrl + path, method: () => method,
      resourceType: () => type, frame: () => target.mainFrame(), redirectedFrom: () => redirected ? {} : null,
      isNavigationRequest: () => navigation, headers: () => headers, failure: () => ({ errorText: failure }) };
    implementation.set(value, serverRequest);
    return value;
  };
  const native = (overrides = {}) => {
    manager._requests.set("native-icon", { request: serverRequest });
    session.emit("Network.requestWillBeSent", { requestId: "native-icon", frameId: "native-main-frame",
      url: baseUrl + "/icon.svg", method: "GET", cause: "TYPE_IMAGE",
      internalCause: "TYPE_INTERNAL_IMAGE_FAVICON", ...overrides });
  };
  const start = (value, target = page) => {
    evidence.observeRequest(value, "auth", target);
    context.emit("request", value);
  };
  const response = (value, status) => evidence.observeResponse({ request: () => value,
    status: () => status, headers: () => ({ "content-type": "image/svg+xml" }) });
  return { evidence, context, page, frame, session, manager, implementation, connection,
    serverRequest, request, native, start, response };
}

it.each([null, 200])("certifies the same native Firefox favicon cancellation with status %s without claiming loading success", async status => {
  const f = await fixture(); const request = f.request(); f.native(); f.start(request);
  if (status !== null) f.response(request, status);
  f.evidence.observeFailure(request);
  expect(f.evidence.reason(request)).toBe("browser_cancelled_favicon");
  const row = f.evidence.snapshot()[0];
  expect(row.failure).toBe("NS_BINDING_ABORTED");
  expect(row.finishedAt).toBeNull();
  const certificate = f.evidence.proofs()[0];
  expect(readMainCancellationProof(certificate).request).toBe(request);
  expect(readMainCancellationProof({ ...certificate })).toBeNull();
});

it.each([
  "no-native-event", "no-collocated-bridge", "chromium", "webkit", "generic-image-cause",
  "wrong-cause", "native-other-url", "native-query", "native-method", "native-identity-missing",
  "client-query", "other-asset", "api-path", "client-method", "fetch", "script", "document",
  "network-reset", "unexplained-failure", "http-404", "http-500", "http-201", "redirect",
  "navigation", "fetch-identity", "other-native-object", "late-native-event", "duplicate-native-event",
])("does not excuse %s", async mode => {
  const f = await fixture({ engine: ["chromium", "webkit"].includes(mode) ? mode : "firefox",
    collocated: mode !== "no-collocated-bridge" });
  const request = f.request({
    path: mode === "client-query" ? "/icon.svg?user=1" : mode === "other-asset" ? "/logo.svg" : mode === "api-path" ? "/api/posts" : "/icon.svg",
    method: mode === "client-method" ? "POST" : "GET",
    type: ["fetch", "script", "document"].includes(mode) ? mode : "image",
    redirected: mode === "redirect", navigation: mode === "navigation",
    headers: mode === "fetch-identity" ? { "x-aurora-e2e-read-id": "programmatic-read" } : {},
    failure: mode === "network-reset" ? "NS_ERROR_NET_RESET" : mode === "unexplained-failure" ? "net::ERR_FAILED" : "NS_BINDING_ABORTED",
  });
  const native = () => f.native({
    ...(mode === "generic-image-cause" ? { internalCause: "TYPE_INTERNAL_IMAGE" } : {}),
    ...(mode === "wrong-cause" ? { cause: "TYPE_FETCH" } : {}),
    ...(mode === "native-other-url" ? { url: "https://unrelated.invalid/icon.svg" } : {}),
    ...(mode === "native-query" ? { url: baseUrl + "/icon.svg?user=1" } : {}),
    ...(mode === "native-method" ? { method: "POST" } : {}),
    ...(mode === "native-identity-missing" ? { requestId: "" } : {}),
  });
  if (!["no-native-event", "late-native-event"].includes(mode)) native();
  if (mode === "duplicate-native-event") native();
  if (mode === "other-native-object") f.implementation.set(request, {});
  f.start(request);
  if (mode === "late-native-event") native();
  if (mode.startsWith("http-")) f.response(request, Number(mode.slice(5)));
  f.evidence.observeFailure(request);
  expect(f.evidence.reason(request)).toBeNull();
  expect(f.evidence.proofs()).toEqual([]);
});

it("cannot lend one native Request identity to another client Request", async () => {
  const f = await fixture(); const first = f.request(); f.native(); f.start(first);
  const second = f.request(); f.start(second);
  f.evidence.observeFailure(first); f.evidence.observeFailure(second);
  expect(f.evidence.reason(first)).toBeNull(); expect(f.evidence.reason(second)).toBeNull();
});

it("a copied protocol-shaped browser event supplies no native certificate", async () => {
  const f = await fixture(); const request = f.request();
  f.evidence.observeNative(f.page, { kind: "favicon", documentId: "doc", method: "GET", url: request.url(),
    cause: "TYPE_IMAGE", internalCause: "TYPE_INTERNAL_IMAGE_FAVICON" });
  f.start(request); f.evidence.observeFailure(request);
  expect(f.evidence.reason(request)).toBeNull();
});

it("retains a captured native certificate after context cleanup", async () => {
  const f = await fixture(); const request = f.request(); f.native(); f.start(request);
  f.evidence.observeFailure(request);
  const certificate = f.evidence.proofs()[0];
  f.context.emit("close");
  f.connection.toImpl = () => { throw new Error("dispatcher disposed"); };
  expect(f.session.listenerCount("Network.requestWillBeSent")).toBe(0);
  expect(readMainCancellationProof(certificate).reason).toBe("browser_cancelled_favicon");
});

it("revokes an issued certificate if its native object is subsequently aliased", async () => {
  const f = await fixture(); const request = f.request(); f.native(); f.start(request);
  f.evidence.observeFailure(request);
  const certificate = f.evidence.proofs()[0];
  f.start(f.request());
  expect(readMainCancellationProof(certificate)).toBeNull();
});

it.each(["other-page", "subframe", "mismatched-row-page"])("does not transfer favicon proof to %s", async mode => {
  const f = await fixture(); const request = f.request(); f.native();
  const otherPage = { _connection: f.connection, mainFrame: () => ({ page: () => otherPage }) };
  if (mode === "other-page") request.frame = () => otherPage.mainFrame();
  if (mode === "subframe") request.frame = () => ({ page: () => f.page });
  f.start(request, mode === "mismatched-row-page" ? otherPage : f.page);
  f.evidence.observeFailure(request);
  expect(f.evidence.reason(request)).toBeNull();
});

it("rejects contradictory native causes for the same Request", async () => {
  const f = await fixture(); const request = f.request();
  f.native({ internalCause: "TYPE_INTERNAL_IMAGE" }); f.native(); f.start(request);
  f.evidence.observeFailure(request);
  expect(f.evidence.reason(request)).toBeNull();
});

it("does not certify a Request reported both finished and failed", async () => {
  const f = await fixture(); const request = f.request(); f.native(); f.start(request);
  f.evidence.observeFinished(request); f.evidence.observeFailure(request);
  expect(f.evidence.reason(request)).toBeNull();
});
