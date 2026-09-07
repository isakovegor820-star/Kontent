import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { classifyChannelOnboardingCancellation, createChannelOnboardingNetworkTracker, runChannelOnboardingCoverage } from "./e2e-channel-onboarding-coverage.mjs";
import { createMainRequestEvidence } from "./e2e-main-request-evidence.mjs";
import { createE2eBrowserProxy } from "./e2e-browser-proxy.mjs";

vi.mock("./e2e-browser-proxy.mjs", () => ({ createE2eBrowserProxy: vi.fn(async () => ({
  proxyOptions: { server: "http://127.0.0.1:63344" }, attach: vi.fn(),
  snapshot: () => [], expectedDeniedSnapshot: () => [], assertClean: vi.fn(), stop: vi.fn(),
  withExpectedDeniedConnect: async (_options, action) => action(),
})) }));

const prefetch = { firstParty: true, method: "GET", path: "/app/settings", type: "fetch", isRscQuery: true,
  rsc: "1", prefetch: "1", segmentPrefetch: true, status: 200, contentType: "text/x-component", failure: "net::ERR_ABORTED" };
const keepalive = { firstParty: true, method: "POST", path: "/api/product-events", type: "fetch", status: 200,
  contentType: "application/json", failure: "net::ERR_ABORTED" };

describe("onboarding evidenced cancellations", () => {
  it("recognizes the observed successful RSC prefetch and acknowledged telemetry response", () => {
    expect(classifyChannelOnboardingCancellation(prefetch)).toBe("completed_rsc_prefetch");
    expect(classifyChannelOnboardingCancellation({ ...prefetch, path: "/admin" })).toBe("completed_rsc_prefetch");
    expect(classifyChannelOnboardingCancellation(keepalive)).toBe("acknowledged_keepalive");
  });
  it.each([
    { firstParty: false }, { type: "document" }, { isRscQuery: false }, { rsc: null },
    { prefetch: null, segmentPrefetch: false }, { status: 503 }, { status: undefined },
    { contentType: "application/json" }, { path: "/api/channels" }, { path: "/login" },
    { method: "POST" }, { failure: "net::ERR_CONNECTION_RESET" }, { failure: "net::ERR_CONTENT_LENGTH_MISMATCH" },
  ])("retains a nonmatching RSC failure: %j", (delta) => {
    expect(classifyChannelOnboardingCancellation({ ...prefetch, ...delta })).toBeNull();
  });
  it.each([
    { status: undefined }, { status: 500 }, { method: "PATCH" }, { path: "/api/bot/link" },
    { path: "/api/channels" }, { contentType: "text/html" }, { type: "document" }, { firstParty: false },
    { failure: "net::ERR_CONNECTION_RESET" },
  ])("retains failed/unacknowledged writes: %j", (delta) => {
    expect(classifyChannelOnboardingCancellation({ ...keepalive, ...delta })).toBeNull();
  });
  it("retains even a successful API read cancellation without hiding it as navigation", () => {
    expect(classifyChannelOnboardingCancellation({ ...prefetch, path: "/api/channels/tenchat", contentType: "application/json" })).toBeNull();
  });
});

function setup() {
  const page = new EventEmitter(); page.url = () => "https://127.0.0.1:63345/app/settings?section=channels";
  const tracker = createChannelOnboardingNetworkTracker({ page, baseUrl: "https://127.0.0.1:63345", waitFor: async () => {} });
  const emitRequest = (path, { method = "GET", headers = {}, status = 200, contentType = "text/x-component", failure = "net::ERR_ABORTED" } = {}) => {
    const request = { url: () => "https://127.0.0.1:63345" + path, method: () => method, headers: () => headers,
      resourceType: () => "fetch", isNavigationRequest: () => false, failure: () => ({ errorText: failure }) };
    page.emit("request", request);
    if (status != null) page.emit("response", { request: () => request, status: () => status, headers: () => ({ "content-type": contentType }) });
    page.emit("requestfailed", request);
    return request;
  };
  return { page, tracker, emitRequest };
}

describe("onboarding network evidence", () => {
  it("records the real response before classifying cancellation and retains independent HTTP/page failures", () => {
    const { page, tracker, emitRequest } = setup();
    emitRequest("/app/calendar?_rsc=opaque", { headers: { rsc: "1", "next-router-prefetch": "1" } });
    emitRequest("/api/product-events", { method: "POST", contentType: "application/json" });
    emitRequest("/api/bot/link", { method: "POST", status: 503, contentType: "application/json" });
    page.emit("pageerror", new TypeError("private message must not be persisted"));
    const result = tracker.snapshot();
    expect(result.knownCancellations.map((row) => row.reason)).toEqual(["completed_rsc_prefetch", "acknowledged_keepalive"]);
    expect(result.unexpected.map((row) => row.kind)).toEqual(["http", "pageerror", "requestfailed"]);
    expect(result.knownCancellations.every((row) => row.responseAt <= row.failedAt)).toBe(true);
    tracker.stop();
  });
  it("does not serialize query values, arbitrary headers, cookies, response bodies or the Telegram credential", () => {
    const { tracker, emitRequest } = setup(); const canary = "ONETIME_CREDENTIAL_CANARY_1234567890";
    emitRequest("/app/settings?_rsc=opaque&token=" + canary, { headers: { rsc: "1", "next-router-prefetch": "1",
      "next-router-segment-prefetch": canary, authorization: canary, cookie: canary } });
    const serialized = JSON.stringify(tracker.snapshot());
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain("?_rsc");
    expect(serialized).not.toContain("authorization");
    expect(tracker.snapshot().network[0]).toMatchObject({ path: "/app/settings", isRscQuery: true, segmentPrefetch: true });
    tracker.stop();
  });
  it("keeps unknown API aborts unexpected even during a completed navigation", async () => {
    const { tracker, emitRequest } = setup();
    await tracker.navigate("reload", async () => emitRequest("/api/channels/tenchat", { contentType: "application/json" }));
    const result = tracker.snapshot();
    expect(result.navigations[0]).toMatchObject({ complete: true, destination: "/app/settings" });
    expect(result.knownCancellations).toEqual([]);
    expect(result.unexpected).toHaveLength(1);
    expect(result.unexpected[0]).toMatchObject({ kind: "requestfailed", path: "/api/channels/tenchat", navigationId: 1 });
    tracker.stop();
  });
});

describe("onboarding owns its browser boundary", () => {
  it("stops its transport when context creation fails", async () => {
    await expect(runChannelOnboardingCoverage({ browser: { newContext: async () => { throw new Error("context setup failed"); } },
      baseUrl: "https://127.0.0.1:63345", pool: { options: { connectionString: "postgres://egor@127.0.0.1:63347/aurora_e2e_real" } },
    })).rejects.toThrow("context setup failed");
    const transport = await createE2eBrowserProxy.mock.results.at(-1).value;
    expect(transport.stop).toHaveBeenCalledOnce();
  });
  it("closes context and transport when setup fails before its page exists", async () => {
    const context = Object.assign(new EventEmitter(), { route: vi.fn(), unroute: vi.fn(), unrouteAll: vi.fn(), pages: () => [],
      exposeBinding: vi.fn(), addInitScript: vi.fn(),
      addCookies: vi.fn(async () => { throw new Error("cookie setup failed"); }), close: vi.fn() });
    context.close.mockImplementation(async () => { context.emit("close"); });
    await expect(runChannelOnboardingCoverage({ browser: { newContext: async () => context }, cookies: [],
      baseUrl: "https://127.0.0.1:63345", pool: { options: { connectionString: "postgres://egor@127.0.0.1:63347/aurora_e2e_real" } },
    })).rejects.toThrow("cookie setup failed");
    const transport = await createE2eBrowserProxy.mock.results.at(-1).value;
    expect(context.close).toHaveBeenCalledOnce(); expect(transport.stop).toHaveBeenCalledOnce();
    expect(context.exposeBinding.mock.calls.filter(([name]) => name === "__recordChannelNativeBody")).toHaveLength(1);
    expect(context.exposeBinding.mock.calls.filter(([name]) => name === "__auroraMainReadLifetime")).toHaveLength(1);
  });
  it("installs deny before its fake client exception and retains safely redacted external attempts on failure", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "aurora-channel-boundary-"));
    const baseUrl = "https://127.0.0.1:63345";
    const canary = "ONETIME_PRIVATE_CANARY";
    const routes = []; const outcomes = [];
    const context = Object.assign(new EventEmitter(), { route: vi.fn(async (pattern, handler) => { routes.push({ pattern, handler }); }),
      unroute: vi.fn(), unrouteAll: vi.fn(), pages: () => [],
      exposeBinding: vi.fn(), addInitScript: vi.fn(), addCookies: vi.fn(), newPage: vi.fn(), close: vi.fn() });
    const visit = async (url) => {
      const matches = routes.filter(({ pattern }) => pattern === "**/*" || url.startsWith("https://t.me/"));
      const outcome = { fallback: 0, aborted: null, fulfilled: null };
      const handle = async (index) => {
        if (index < 0) { outcome.fallback += 1; return; }
        await matches[index].handler({ request: () => ({ url: () => url, method: () => "GET", resourceType: () => "document" }),
          fallback: () => handle(index - 1), abort: async (reason) => { outcome.aborted = reason; },
          fulfill: async (response) => { outcome.fulfilled = response; } });
      };
      try { await handle(matches.length - 1); }
      catch (error) { outcome.error = error.name; }
      outcomes.push(outcome);
    };
    const page = Object.assign(new EventEmitter(), { route: vi.fn(), unroute: vi.fn(), unrouteAll: vi.fn() });
    let currentUrl = "about:blank";
    page.url = () => currentUrl;
    page.evaluate = async () => { expect(currentUrl).toBe("about:blank"); return { uninitialized: true }; };
    page.goto = async () => {
      currentUrl = baseUrl + "/app/settings";
      await visit(baseUrl + "/app/settings");
      await visit("https://t.me/aurora_e2e_bot?start=" + "a".repeat(32) + "_channel");
      await visit("https://t.me/" + canary + "?start=" + canary);
      await visit("https://t.me/aurora_e2e_bot?start=" + canary);
      await visit("https://provider.invalid/" + canary + "?token=" + canary);
      throw new Error("controlled stop after routing observations");
    };
    context.newPage.mockImplementation(async () => { context.emit("page", page); return page; });
    context.close.mockImplementation(async () => { await visit("https://late.invalid/" + canary); context.emit("close"); });
    const newContext = vi.fn(async () => context);
    try {
      await expect(runChannelOnboardingCoverage({ browser: { newContext }, cookies: [], baseUrl,
        pool: { options: { connectionString: "postgres://egor@127.0.0.1:63347/aurora_e2e_real" } },
        userId: 1, projectId: 1, waitFor: vi.fn(), artifactDir })).rejects.toThrow("controlled stop");
      expect(outcomes[0]).toMatchObject({ fallback: 1, aborted: null, fulfilled: null });
      expect(outcomes[1]).toMatchObject({ fallback: 0, aborted: null, fulfilled: { status: 200 } });
      expect(outcomes.slice(2).every((outcome) => outcome.aborted === "blockedbyclient" && outcome.fallback === 0 && outcome.fulfilled === null)).toBe(true);
      expect(routes.map(({ pattern }) => pattern)).toEqual(["**/*", "**/*", "https://t.me/**"]);
      expect(context.route.mock.invocationCallOrder[0]).toBeLessThan(context.addCookies.mock.invocationCallOrder[0]);
      const serialized = await readFile(join(artifactDir, "channel-onboarding-network.json"), "utf8");
      const result = JSON.parse(serialized);
      expect(result.browserBoundary).toHaveLength(4);
      expect(result.browserBoundary.every((row) => row.kind === "external_request")).toBe(true);
      expect(result.lifecycleFailure).toBe(true);
      expect(serialized).not.toContain(canary);
      expect(serialized).not.toContain("provider.invalid");
      expect(serialized).not.toContain("a".repeat(32));
      expect(context.close).toHaveBeenCalledOnce();
      const transport = await createE2eBrowserProxy.mock.results.at(-1).value;
      expect(newContext).toHaveBeenCalledWith(expect.objectContaining({ proxy: transport.proxyOptions }));
      expect(transport.attach).toHaveBeenCalledWith(context);
      expect(transport.stop).toHaveBeenCalledOnce();
    } finally { await rm(artifactDir, { recursive: true, force: true }); }
  });
});

// Exercise the real collector and native identity verifier together. Matching
// URL/timing alone, collisions and earlier network errors are negative controls.
it.each(["caller", "no-native", "other-identity", "collision", "reset", "late-abort"])("onboarding exact native request evidence: %s", (kind) => {
  const baseUrl = "https://127.0.0.1:63345"; let time = 1000;
  const page = Object.assign(new EventEmitter(), { url: () => baseUrl + "/app/settings" });
  const readEvidence = createMainRequestEvidence({ baseUrl, now: () => time });
  const tracker = createChannelOnboardingNetworkTracker({ page, baseUrl, readEvidence, waitFor: vi.fn() });
  const request = { url: () => baseUrl + "/api/channels/tenchat", method: () => "GET", resourceType: () => "fetch",
    isNavigationRequest: () => false, headers: () => ({ "x-aurora-e2e-read-id": "owned-1" }),
    failure: () => ({ errorText: kind === "reset" ? "net::ERR_CONNECTION_RESET" : "net::ERR_ABORTED" }) };
  const native = (event, extra = {}) => readEvidence.observeNative(page, { kind: event, documentId: "doc", id: 1,
    identity: kind === "other-identity" ? "forged" : "owned-1", method: "GET", at: time, url: request.url(), ...extra });
  readEvidence.observeNative(page, { kind: "document", documentId: "doc" });
  if (kind !== "no-native") native("start");
  page.emit("request", request);
  if (kind === "collision") page.emit("request", { ...request });
  const response = { request: () => request, status: () => 200, headers: () => ({ "content-type": "application/json" }) };
  page.emit("response", response);
  time = 1100;
  if (kind === "late-abort") { native("failure", { callerAbort: false }); time = 1200; }
  if (kind !== "no-native") { native("abort"); native("failure", { callerAbort: true }); }
  page.emit("requestfailed", request);
  const result = tracker.snapshot();
  expect(result.knownCancellations.map(row => row.reason)).toEqual(kind === "caller" ? ["caller_abort_signal"] : []);
  expect(result.unexpected).toHaveLength(kind === "caller" ? 0 : 1);
  tracker.stop();
});
it("onboarding waits for the renderer/read barrier before changing documents", async () => {
  const page = Object.assign(new EventEmitter(), { url: () => "https://127.0.0.1:63345/app/settings" });
  let release; const pending = new Promise(resolve => { release = resolve; });
  const readEvidence = { settleReads: vi.fn(() => pending) };
  const tracker = createChannelOnboardingNetworkTracker({ page, baseUrl: page.url(), waitFor: vi.fn(), readEvidence });
  const action = vi.fn(); const navigation = tracker.navigate("reload", action);
  await Promise.resolve(); const premature = action.mock.calls.length;
  release(); await navigation;
  expect(premature).toBe(0); expect(readEvidence.settleReads).toHaveBeenCalledWith(page);
  expect(action).toHaveBeenCalledOnce(); tracker.stop();
});
