import { beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { finalizeE2eBrowserLifecycle } from "./e2e-browser-lifecycle.mjs";

function lifecycle() {
  const events = [];
  const attempts = [];
  const context = { close: vi.fn(async () => { events.push("close"); }) };
  const transport = {
    stop: vi.fn(async () => { events.push("stop"); }),
    assertClean: vi.fn(() => { events.push("assert"); if (attempts.length) throw new Error("unexpected external request"); }),
    snapshot: vi.fn(() => [...attempts]),
  };
  return { events, attempts, context, transport };
}

it("drains the context and transport before asserting and publishing evidence", async () => {
  const state = lifecycle();
  await finalizeE2eBrowserLifecycle({ ...state,
    beforeClose: [() => state.events.push("trace")],
    cleanup: [() => state.events.push("profile")],
    assertDiagnostics: () => { state.events.push("diagnostics"); },
    writeEvidence: ({ error, transportAttempts }) => { expect(error).toBeUndefined(); expect(transportAttempts).toEqual([]); state.events.push("evidence"); },
  });
  expect(state.events).toEqual(["trace", "close", "stop", "profile", "assert", "diagnostics", "evidence"]);
});

it("fails on a retained denial arriving during close and records that final denial", async () => {
  const state = lifecycle(); const record = { kind: "external_request" }; let evidence;
  state.context.close.mockImplementation(async () => { state.attempts.push(record); });
  await expect(finalizeE2eBrowserLifecycle({ ...state, writeEvidence: (result) => { evidence = result; } })).rejects.toThrow("unexpected external request");
  expect(evidence.error.message).toContain("unexpected external request");
  expect(evidence.transportAttempts).toEqual([record]);
  expect(state.transport.stop).toHaveBeenCalledOnce();
});

it("preserves primary and cleanup errors while attempting every owned cleanup and evidence write", async () => {
  const state = lifecycle(); const primary = new Error("original scenario failure");
  const trace = new Error("trace failure"); const close = new Error("close failure"); const stop = new Error("stop failure");
  const cleanup = new Error("profile failure"); const diagnostic = new Error("late page error"); const write = new Error("evidence failure"); let evidence;
  state.context.close.mockRejectedValue(close); state.transport.stop.mockRejectedValue(stop);
  const result = await finalizeE2eBrowserLifecycle({ ...state, error: primary,
    beforeClose: [() => { throw trace; }], cleanup: [() => { throw cleanup; }],
    assertDiagnostics: () => { throw diagnostic; },
    writeEvidence: (value) => { evidence = value; throw write; },
  }).catch((error) => error);
  expect(result).toBeInstanceOf(AggregateError);
  expect(result.cause).toBe(primary);
  expect(result.errors).toEqual([primary, trace, close, stop, cleanup, diagnostic, write]);
  expect(evidence.error.errors).toEqual([primary, trace, close, stop, cleanup, diagnostic]);
  expect(state.transport.assertClean).toHaveBeenCalledOnce();
});

it("cleans partially acquired resources and keeps the original error identity", async () => {
  const state = lifecycle(); const primary = new Error("setup failed");
  await expect(finalizeE2eBrowserLifecycle({ transport: state.transport, error: primary })).rejects.toBe(primary);
  expect(state.transport.stop).toHaveBeenCalledOnce(); expect(state.transport.assertClean).toHaveBeenCalledOnce();
});

it("does not hide route-boundary denials or snapshot failures", async () => {
  const state = lifecycle(); const denial = new Error("route denied"); const snapshot = new Error("snapshot failed");
  const boundary = { assertClean: () => { throw denial; }, snapshot: () => { throw snapshot; } };
  const result = await finalizeE2eBrowserLifecycle({ ...state, boundary }).catch((error) => error);
  expect(result.errors).toEqual([denial, snapshot]);
  expect(state.transport.assertClean).toHaveBeenCalledOnce();
});

it("retains a transport denial and renderer error collected by an asynchronous final cleanup", async () => {
  const state = lifecycle(); const diagnostics = []; let evidence;
  const result = await finalizeE2eBrowserLifecycle({ ...state,
    cleanup: [async () => { await Promise.resolve(); state.attempts.push({ kind: "cleanup_denial" }); diagnostics.push("late pageerror"); }],
    assertDiagnostics: () => { if (diagnostics.length) throw new Error(diagnostics[0]); },
    writeEvidence: (value) => { evidence = value; },
  }).catch((error) => error);
  expect(result.errors.map((error) => error.message)).toEqual(["unexpected external request", "late pageerror"]);
  expect(evidence.error).toBeInstanceOf(AggregateError);
  expect(evidence.transportAttempts).toEqual([{ kind: "cleanup_denial" }]);
});

const mocks = vi.hoisted(() => ({ createProxy: vi.fn(), createContext: vi.fn(), installBoundary: vi.fn(), launch: vi.fn(),
  createOffline: vi.fn(), mkdtemp: vi.fn(), mkdir: vi.fn(), writeFile: vi.fn(), rm: vi.fn() }));
vi.mock("./e2e-browser-proxy.mjs", () => ({ createE2eBrowserProxy: mocks.createProxy }));
vi.mock("./e2e-browser-context.mjs", () => ({ createE2eBrowserContext: mocks.createContext }));
vi.mock("./e2e-browser-boundary.mjs", () => ({ installE2eBrowserBoundary: mocks.installBoundary }));
vi.mock("playwright-core", () => ({ chromium: { executablePath: () => "/synthetic/chromium", launchPersistentContext: mocks.launch } }));
vi.mock("./e2e-chromium-offline-profile.mjs", () => ({ createE2eChromiumOfflineProfile: mocks.createOffline }));
vi.mock("node:fs/promises", async (original) => ({ ...await original(), mkdtemp: mocks.mkdtemp, mkdir: mocks.mkdir, writeFile: mocks.writeFile, rm: mocks.rm }));
import { runTrueZoomCoverage } from "./e2e-true-zoom-coverage.mjs";
import { runAuthCoverage } from "./e2e-auth-coverage.mjs";
import { runAdminActionsCoverage } from "./e2e-admin-actions-coverage.mjs";
import { runEditorSafetyCoverage } from "./e2e-editor-safety-coverage.mjs";
import { runLoginRateLimitCoverage, loginRateLimitFixtureIngress, LOGIN_RATE_LIMIT_FIXTURE_HEADER } from "./e2e-login-rate-limit-coverage.mjs";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mkdtemp.mockResolvedValue("/synthetic-owned-profile"); mocks.mkdir.mockResolvedValue(undefined);
  mocks.writeFile.mockResolvedValue(undefined); mocks.rm.mockResolvedValue(undefined);
  mocks.installBoundary.mockResolvedValue({ assertClean() {}, snapshot: () => [] });
  mocks.createOffline.mockResolvedValue({ profilePath: "/synthetic-owned-profile", launchArgs: ["--synthetic-owned-service=1"],
    serviceFixture: { kind: "synthetic-owned-fixture" }, snapshot: () => ({ requests: [] }),
    stop: () => mocks.rm("/synthetic-owned-profile", { recursive: true, force: true }) });
});
function browserFixture() {
  const state = lifecycle();
  const bindings = new Map(); let documentId = null;
  const frame = { page: () => page };
  const locator = { first() { return this; }, async waitFor() {} };
  const page = { on() {}, off() {}, url: () => "http://127.0.0.1/", mainFrame: () => frame,
    goto: async () => { documentId = "fixture-document"; await bindings.get("__auroraMainReadLifetime")?.({ page, frame }, { kind: "document", documentId }); },
    getByRole: () => locator, locator: () => locator,
    keyboard: { press: async () => {} }, evaluate: async (fn) => {
      const source = fn.toString();
      if (source.includes("Owned renderer settlement")) return documentId ? { documentId } : { uninitialized: true };
      if (/const root\s*=/u.test(source)) return { outerWidth: 1280, innerWidth: 640, visualScale: 1, cssZoom: "1", scrollWidth: 640, contrast: [] };
      if (source.includes("document.activeElement")) return { visible: true, width: 100, left: 0, right: 100, href: null };
    } };
  Object.assign(state.context, { pages: () => [page], on() {}, off() {}, exposeBinding: async (name, fn) => { bindings.set(name, fn); }, newCDPSession: async () => ({ send: async () => ({ data: "" }) }), addCookies: async () => {}, addInitScript: async () => {} });
  Object.assign(state.transport, { proxyOptions: { server: "http://127.0.0.1:1" }, attach() {} });
  mocks.launch.mockResolvedValue(state.context); mocks.createProxy.mockResolvedValue(state.transport);
  mocks.createContext.mockResolvedValue({ context: state.context, transport: state.transport });
  return state;
}
const zoomOptions = { baseUrl: "http://127.0.0.1:12345", cookies: [], projectId: 1, artifactDir: "/synthetic-evidence",
  browserServiceTls: { key: "synthetic-key", cert: "synthetic-cert" } };

it("true zoom cleans the persistent browser, transport and profile after boundary installation fails", async () => {
  const state = browserFixture(); const error = new Error("boundary install failed"); mocks.installBoundary.mockRejectedValue(error);
  await expect(runTrueZoomCoverage(zoomOptions)).rejects.toBe(error);
  expect(state.context.close).toHaveBeenCalledOnce(); expect(state.transport.stop).toHaveBeenCalledOnce();
  expect(mocks.rm).toHaveBeenCalledWith("/synthetic-owned-profile", { recursive: true, force: true });
});

it("true zoom uses the guarded context adapter while preserving native zoom launch settings", async () => {
  const state = browserFixture(); const error = new Error("stop after guarded launch");
  mocks.installBoundary.mockRejectedValue(error);
  mocks.createContext.mockImplementation(async (adapter, options) => {
    expect(options).toMatchObject({ baseUrl: zoomOptions.baseUrl, viewport: null, reducedMotion: "reduce", ignoreHTTPSErrors: true,
      serviceFixture: { kind: "synthetic-owned-fixture" } });
    const context = await adapter.newContext({ ...options, proxy: state.transport.proxyOptions, serviceWorkers: "block" });
    return { context, transport: state.transport };
  });
  await expect(runTrueZoomCoverage(zoomOptions)).rejects.toBe(error);
  expect(mocks.launch).toHaveBeenCalledWith("/synthetic-owned-profile", expect.objectContaining({
    viewport: null, headless: true, executablePath: "/synthetic/chromium", args: ["--window-size=1280,1000", "--synthetic-owned-service=1"],
    proxy: state.transport.proxyOptions, serviceWorkers: "block",
  }));
  expect(mocks.createOffline).toHaveBeenCalledWith({ baseUrl: zoomOptions.baseUrl, tls: zoomOptions.browserServiceTls, zoom: 2 });
});

it("true zoom preserves offline-profile setup failure without launching a browser", async () => {
  const error = new Error("offline profile failed"); mocks.createOffline.mockRejectedValue(error);
  await expect(runTrueZoomCoverage(zoomOptions)).rejects.toBe(error);
  expect(mocks.launch).not.toHaveBeenCalled(); expect(mocks.createContext).not.toHaveBeenCalled();
});

it("true zoom removes its acquired profile even when context creation fails", async () => {
  browserFixture(); const error = new Error("context creation failed"); mocks.createContext.mockRejectedValue(error);
  vi.useFakeTimers();
  try {
    const assertion = expect(runTrueZoomCoverage(zoomOptions)).rejects.toBe(error);
    void assertion.catch(() => {}); // Await the same assertion after advancing the mocked clock.
    await vi.runAllTimersAsync(); await assertion;
  } finally { vi.useRealTimers(); }
  expect(mocks.rm).toHaveBeenCalledWith("/synthetic-owned-profile", { recursive: true, force: true });
});

it("true zoom rejects late denial and writes the failure after context drain", async () => {
  const state = browserFixture(); state.context.close.mockImplementation(async () => { state.attempts.push({ kind: "external_request" }); });
  vi.useFakeTimers();
  try {
    const assertion = expect(runTrueZoomCoverage(zoomOptions)).rejects.toThrow("unexpected external request");
    void assertion.catch(() => {}); // Await the same assertion after advancing the mocked clock.
    await vi.runAllTimersAsync(); await assertion;
  } finally { vi.useRealTimers(); }
  const body = JSON.parse(mocks.writeFile.mock.calls.find(([file]) => file.endsWith("true-zoom-coverage.json"))[1]);
  expect(body.failure).toContain("unexpected external request"); expect(body.transportAttempts).toEqual([{ kind: "external_request" }]);
});

it("true zoom keeps the successful control and publishes it after cleanup", async () => {
  const state = browserFixture(); let result;
  vi.useFakeTimers();
  try {
    const running = runTrueZoomCoverage(zoomOptions);
    await vi.runAllTimersAsync(); result = await running;
  } finally { vi.useRealTimers(); }
  expect(result.failure).toBeUndefined(); expect(result.screens).toHaveLength(10);
  expect(result.transportAttempts).toEqual([]); expect(state.context.close).toHaveBeenCalledOnce();
});

it.each(["auth", "admin"])("%s closes a context when route-boundary setup fails", async (kind) => {
  const state = browserFixture(); const error = new Error("setup boundary failed"); mocks.installBoundary.mockRejectedValue(error);
  const fn = kind === "auth" ? runAuthCoverage : runAdminActionsCoverage;
  if (kind === "auth") {
    const failure = await fn({ browser: {}, baseUrl: zoomOptions.baseUrl, pool: { query: async () => ({ rows: [{ id: 1 }] }) } }).catch(value => value);
    expect(failure).not.toBe(error);
    expect(failure.authFailure).toMatchObject({ name: error.name, messageHash: createHash("sha256").update(error.message).digest("hex") });
    expect(failure.cause).toBeUndefined();
    expect(state.events).toEqual(["close", "stop", "assert"]);
    const written = JSON.parse(mocks.writeFile.mock.calls.find(([file]) => file.endsWith("auth-coverage-result.json"))[1]);
    expect(written.complete).toBe(false); expect(written.failure).toMatchObject(failure.authFailure);
  } else await expect(fn({ browser: {}, baseUrl: zoomOptions.baseUrl, pool: { query: async () => ({ rows: [{ id: 1 }] }) } })).rejects.toBe(error);
  expect(state.context.close).toHaveBeenCalledOnce(); expect(state.transport.stop).toHaveBeenCalledOnce();
});

it.each(["trace-start", "binding"])("editor cleans a partially initialized context after %s fails", async (stage) => {
  const state = browserFixture(); const error = new Error(`${stage} failed`);
  state.context.tracing = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
  state.context.exposeBinding = vi.fn(async () => {});
  if (stage === "trace-start") state.context.tracing.start.mockRejectedValue(error);
  else state.context.exposeBinding.mockRejectedValue(error);
  const pool = { options: { connectionString: "postgres://fixture@127.0.0.1/aurora_e2e_real" },
    connect: async () => ({ query: async () => ({ rows: [{ id: 1 }] }), release() {} }) };
  await expect(runEditorSafetyCoverage({ browser: {}, baseUrl: zoomOptions.baseUrl, pool, projectId: 1, artifactDir: "/synthetic-evidence" })).rejects.toBe(error);
  expect(state.context.close).toHaveBeenCalledOnce(); expect(state.transport.stop).toHaveBeenCalledOnce();
  expect(state.context.tracing.stop).toHaveBeenCalledTimes(stage === "binding" ? 1 : 0);
  const body = JSON.parse(mocks.writeFile.mock.calls.find(([file]) => file.endsWith("editor-safety-result.json"))[1]);
  expect(body).toMatchObject({ ok: false, phase: "setup", message: error.message, transportAttempts: [] });
});

it("login throttling releases its reserved ingress and only its owned keys when context setup fails", async () => {
  const error = new Error("context setup failed"); let token;
  mocks.createContext.mockImplementation(async (_browser, options) => { token = options.extraHTTPHeaders[LOGIN_RATE_LIMIT_FIXTURE_HEADER];
    expect(loginRateLimitFixtureIngress.resolve({ [LOGIN_RATE_LIMIT_FIXTURE_HEADER]: token })).toMatch(/^192\.0\.2\./); throw error; });
  const redis = { options: { host: "127.0.0.1" }, exists: vi.fn(async () => 0), get: vi.fn(async () => null), ttl: vi.fn(async () => -2), del: vi.fn(async () => 0) };
  const pool = { options: { connectionString: "postgres://fixture@127.0.0.1/aurora_e2e_real" }, query: async () => ({ rows: [{ id: 1 }] }) };
  await expect(runLoginRateLimitCoverage({ browser: {}, baseUrl: zoomOptions.baseUrl, pool, redis, artifactDir: "/synthetic-evidence" })).rejects.toBe(error);
  expect(loginRateLimitFixtureIngress.resolve({ [LOGIN_RATE_LIMIT_FIXTURE_HEADER]: token })).toBeNull();
  expect(redis.del).toHaveBeenCalledWith(expect.stringMatching(/^rl:login:ip:192\.0\.2\./), expect.stringMatching(/^rl:login:acct:qa-login-limit-/));
  const body = JSON.parse(mocks.writeFile.mock.calls.find(([file]) => file.endsWith("login-rate-limit-coverage.json"))[1]);
  expect(body.result).toBe("FAIL"); expect(body.error).toBe(error.message); expect(body.ownedKeysRemaining).toBe(0);
});
