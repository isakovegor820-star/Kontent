import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("real E2E runtime isolation", () => {
  it("builds or validates one isolated artifact and restarts the production entrypoint", () => {
    const source = readFileSync(resolve("scripts/test-e2e-real.mjs"), "utf8");

    expect(source).toContain('AURORA_NEXT_DIST_DIR: ".next-e2e-real"');
    expect(source).toContain('if (buildMode === "reuse")');
    expect(source).toContain('resolve(distDirectory, "BUILD_ID")');
    expect(source).toContain('resolve(distDirectory, "build-manifest.json")');
    expect(source).toContain('resolve(distDirectory, ".aurora-e2e-input-digest")');
    expect(source).toContain("builtFromDigest === e2eInputSnapshot.digest");
    expect(source).toContain("rmSync(distDirectory, { recursive: true, force: true })");
    expect(source.match(/rmSync\(distDirectory/gu)).toHaveLength(1);
    expect(source).toContain('NODE_ENV: "production"');
    expect(source).toContain("const releaseE2eBuildLock = acquireBuildLock");
    expect(source).toContain("AURORA_BUILD_LOCK_TOKEN: e2eBuildLockToken");
    expect(source).toContain("releaseE2eBuildLock()");
    expect(source).toContain('["run", "build"]');
    expect(source).toContain('child(\n    "production-build"');
    expect(source).toContain("Math.min(2_000, remainingMs)");
    expect(source).toContain('await stopChild(buildProcess, "production build")');
    expect(source).toContain("const buildFailureDetail = logs");
    expect(source).toContain('["run", "start", "--", "-H", "127.0.0.1"');
    expect(source).not.toContain('["run", "dev"');
    expect(source).not.toContain(".next-e2e-real-${distSuffix}");
  });

  it("serializes production builds that share generated Next type state", () => {
    const source = readFileSync(resolve("scripts/build.mjs"), "utf8");

    expect(source).toContain("const releaseBuildLock = acquireBuildLock({");
    expect(source).toContain("AURORA_BUILD_LOCK_TOKEN");
    expect(source).toContain("releaseBuildLock()");
    expect(source).toContain('resolve("node_modules/next/dist/bin/next")');
  });

  it("uses an HTTPS browser origin and fails on first-party 5xx responses", () => {
    const source = readFileSync(resolve("scripts/test-e2e-real.mjs"), "utf8");

    expect(source).toContain("const baseUrl = `https://127.0.0.1:${webPort}`");
    expect(source).toContain("await startHttpsProxy()");
    expect(source).toContain('kind: "http.5xx"');
    expect(source).toContain("unexpectedRuntimeLogLines()");
  });

  it("accepts the visible save summary when a resolved error collapses its details", () => {
    const source = readFileSync(resolve("scripts/test-e2e-real.mjs"), "utf8");

    expect(source).toContain('const summary = await protection.locator("summary").textContent()');
    expect(source).toContain('summary?.includes("Сохранено") === true');
    expect(source).toContain('select text from drafts where id = $1 and project_id = $2');
  });

  it("gives cold API compilation the same bounded budget as runtime readiness", () => {
    const source = readFileSync(resolve("scripts/test-e2e-real.mjs"), "utf8");
    const explicitBudgets = source.match(/timeout: API_REQUEST_TIMEOUT_MS/gu) ?? [];

    expect(source).toContain("const API_REQUEST_TIMEOUT_MS = RUNTIME_WAIT_TIMEOUT_MS");
    expect(explicitBudgets.length).toBeGreaterThanOrEqual(6);
  });

  it("reserves dynamic ports instead of relying on shared runner defaults", () => {
    const source = readFileSync(resolve("scripts/test-e2e-real.mjs"), "utf8");

    expect(source).toContain("async function reserveEphemeralPorts(count)");
    expect(source).toContain('server.listen(0, "127.0.0.1", resolveListen)');
    expect(source).toContain('configuredPort("E2E_WEB_PORT")');
    expect(source).toContain('configuredPort("E2E_NEXT_PORT")');
    expect(source).toContain('configuredPort("E2E_FAKE_PORT")');
    expect(source).not.toContain("process.env.E2E_WEB_PORT || 43190");
    expect(source).not.toContain("process.env.E2E_FAKE_PORT || 43191");
  });

  it("keeps the keyboard start sentinel until WebKit has entered the tab sequence", () => {
    const source = readFileSync(resolve("scripts/test-e2e-real.mjs"), "utf8");

    expect(source).toContain("async function focusKeyboardStart(targetPage)");
    expect(source).toContain("document.activeElement === document.body");
    expect(source).toContain("async function releaseKeyboardStart(targetPage)");
    expect(source).not.toContain('document.body.focus();\n    document.body.removeAttribute("tabindex")');
    expect(source.match(/await focusKeyboardStart\(targetPage\)/gu)).toHaveLength(2);
    expect(source.match(/await releaseKeyboardStart\(targetPage\)/gu)).toHaveLength(2);
  });

  it("waits for the detached production process group instead of only the npm wrapper", () => {
    const source = readFileSync(resolve("scripts/test-e2e-real.mjs"), "utf8");

    expect(source).toContain("function processTreeAlive(subprocess)");
    expect(source).toContain("globalThis.process.kill(-subprocess.pid, 0)");
    expect(source).toContain("!processTreeAlive(subprocess)");
    expect(source).toContain("initialShutdown.forced === false");
    expect(source).toContain("gracefulShutdown: true");
  });

  it("proves the publication-block client component hydrated before clicking it", () => {
    const source = readFileSync(resolve("scripts/test-e2e-real.mjs"), "utf8");

    expect(source).toContain("const [publicationBlocksLoad] = await Promise.all");
    expect(source).toContain('new URL(response.url()).pathname === "/api/publication-blocks"');
    expect(source).toContain("publicationBlocksLoad.ok()");
  });

  it("records WebKit screenshot CSP instrumentation without muting CSP outside screenshots", () => {
    const source = readFileSync(resolve("scripts/test-e2e-real.mjs"), "utf8");

    expect(source).toContain("async function captureE2eScreenshot(targetPage, options)");
    expect(source).toContain("browserScreenshotDepth += 1");
    expect(source).toContain("browserScreenshotDepth -= 1");
    expect(source).toContain("observations: browserObservations");
    expect(source).toContain("browserKnownObservations: browserObservations.length");
    expect(source).toContain("screenshotInProgress: browserScreenshotDepth > 0");
    expect(source).not.toContain("style-src 'unsafe-inline'");
  });

  it("waits for authenticated Library content after history restoration", () => {
    const source = readFileSync(resolve("scripts/test-e2e-real.mjs"), "utf8");

    expect(source).toContain("async function waitForRestoredLibrary(targetPage, channelId)");
    expect(source).toContain('name: "Идеи и примеры", exact: true');
    expect(source).toContain('waitForFirstPartyNetworkIdle(targetPage, "history-restored Library")');
    expect(source).toContain('waitForFirstPartyNetworkIdle(page, "Trends before history restoration")');
    expect(source).toContain('waitForFirstPartyNetworkIdle(reviewerPage, "reviewer Calendar reload")');
    expect(source).toContain('targetPage.on("requestfinished", settleRequest)');
    expect(source).toContain('targetPage.on("requestfailed", settleRequest)');
    expect(source).toContain('!url.searchParams.has("_rsc")');
    expect(source.match(/await waitForRestoredLibrary\(page, channels\[0\]\)/gu)).toHaveLength(4);
  });

  it("opts experimental-route E2E harnesses into preview without opening production", () => {
    for (const script of ["scripts/test-e2e-real.mjs", "scripts/test-trends-hydration-e2e.mjs"]) {
      const source = readFileSync(resolve(script), "utf8");
      expect(source).toContain('NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES: "1"');
    }
  });

  it("uses the rendered Trends tab as hydration readiness instead of global network idle", () => {
    const source = readFileSync(resolve("scripts/test-trends-hydration-e2e.mjs"), "utf8");

    expect(source).toContain('waitUntil: "domcontentloaded"');
    expect(source).toContain('internetTab.waitFor({ state: "visible"');
    expect(source).toContain("document.querySelectorAll('[role=\"tab\"][aria-selected=\"true\"]')");
    expect(source).not.toContain('waitUntil: "networkidle"');
  });

  it("keeps the disposable E2E build and runtime outside external Sentry", () => {
    const harness = readFileSync(resolve("scripts/test-e2e-real.mjs"), "utf8");
    const trendsHarness = readFileSync(resolve("scripts/test-trends-hydration-e2e.mjs"), "utf8");
    const nextConfig = readFileSync(resolve("next.config.ts"), "utf8");

    for (const source of [harness, trendsHarness]) {
      expect(source).toContain('AURORA_SENTRY_DISABLED: "1"');
      expect(source).toContain('NEXT_PUBLIC_AURORA_SENTRY_DISABLED: "1"');
      expect(source).toContain('SENTRY_AUTH_TOKEN: ""');
    }
    expect(trendsHarness).toContain('AURORA_RUNTIME_ROLE: "web"');
    expect(trendsHarness).toContain('AURORA_DB_POOL_MAX_WEB: "3"');
    expect(nextConfig).toContain('sourcemaps: sentryDisabled ? { disable: true } : undefined');
    expect(nextConfig).toContain("telemetry: !sentryDisabled");
    expect(nextConfig).toContain("disableSentryConfig: sentryDisabled");
  });

  it("captures the complete BLK-03 evidence set only through an explicit opt-in", () => {
    const source = readFileSync(resolve("scripts/test-e2e-real.mjs"), "utf8");

    expect(source).toContain("resolveE2eCaptureArtifacts(process.env.E2E_CAPTURE_ARTIFACTS)");
    expect(source).toContain("recordVideo:");
    expect(source).toContain("screenshots: true");
    expect(source).toContain("snapshots: false");
    expect(source).toContain("sources: false");
    expect(source.match(/tracing.start\(E2E_EVIDENCE_TRACE_OPTIONS\)/gu)).toHaveLength(2);
    expect(source).toContain('resolve(artifactDir, "network-log.json")');
    expect(source).toContain("sanitizeE2eNetworkUrl(request.url(), baseUrl)");
    expect(source).toContain("assert(traces.length === 2");
    expect(source).toContain("assert(videos.length >= 2");
  });

  it("runs the stability matrix sequentially and rejects incomplete evidence", () => {
    const source = readFileSync(resolve("scripts/test-e2e-stability.mjs"), "utf8");

    expect(source).toContain('E2E_CAPTURE_ARTIFACTS: "1"');
    expect(source).toContain("for (const journey of plan.journeys)");
    expect(source).toContain("await runJourney(journey, directory)");
    expect(source).toContain("if (traces.length !== 2)");
    expect(source).toContain("if (videos.length < 2)");
    expect(source).toContain("if (screenshots.length < 5)");
    expect(source).toContain("async function failedJourneyDetail(directory, output, journeyStartedAtMs)");
    expect(source).toContain("selectFreshJourneyFailureDetail({");
    expect(source).toContain("captureE2eInputSnapshot");
    expect(source).toContain("async function assertStableE2eInputs()");
    expect(source.match(/await assertStableE2eInputs\(\)/gu)).toHaveLength(2);
    expect(source).toContain('manifest.status = "failed"');
    expect(source).toContain('manifest.status = "passed"');
  });

  it("rejects a standalone browser result when inputs changed after its build", () => {
    const source = readFileSync(resolve("scripts/test-e2e-real.mjs"), "utf8");

    expect(source).toContain("const finalInputSnapshot = await captureE2eInputSnapshot()");
    expect(source).toContain("const changedJourneyInputs = changedE2eInputPaths");
    expect(source).toContain("E2E inputs changed during browser journey:");
  });

  it("covers session expiry in two owner tabs without restoring the expired credential", () => {
    const source = readFileSync(resolve("scripts/test-e2e-real.mjs"), "utf8");

    expect(source).toContain("update sessions set expires_at = now() - interval '1 second'");
    expect(source).toContain('context.request.get("/api/auth/me"');
    expect(source).toContain("expiredSessionApi.status() === 401");
    expect(source).toContain('expiredSessionBody?.error === "unauthorized"');
    expect(source).toContain('expectedSessionExpiryConsoleScopes.add("main")');
    expect(source).toContain("classifyE2eExpectedSessionExpiryConsole({");
    expect(source).toContain('waitForFirstPartyNetworkIdle(page, "expired owner main tab")');
    expect(source).toContain("tabsRedirected: 2");
    expect(source).not.toContain("update sessions set expires_at = now() + interval");
    expect(source.indexOf('expectedSessionExpiryConsoleScopes.add("main")', source.indexOf("const activeOwnerSessions")))
      .toBeLessThan(source.indexOf("update sessions set expires_at = now() - interval '1 second'"));
  });

  it("finalizes browser evidence before freezing the successful diagnostic result", () => {
    const source = readFileSync(resolve("scripts/test-e2e-real.mjs"), "utf8");
    const finalizeStart = source.indexOf("async function finalizeBrowserArtifacts");
    const teardownBoundary = source.indexOf("browserTeardownStarted = true", finalizeStart);
    const traceStop = source.indexOf("reviewerContext.tracing.stop", finalizeStart);
    const successArtifacts = source.lastIndexOf("const artifacts = await finalizeBrowserArtifacts()");
    const successDiagnostics = source.lastIndexOf('resolve(artifactDir, "browser-diagnostics.json")', source.indexOf("const result = {"));

    expect(teardownBoundary).toBeGreaterThan(finalizeStart);
    expect(teardownBoundary).toBeLessThan(traceStop);
    expect(successArtifacts).toBeGreaterThan(traceStop);
    expect(successDiagnostics).toBeGreaterThan(successArtifacts);
  });
});
