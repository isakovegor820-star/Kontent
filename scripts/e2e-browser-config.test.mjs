import { describe, expect, it } from "vitest";

import {
  E2E_BUILD_MODES,
  E2E_BROWSER_ENGINES,
  classifyE2eExpectedSessionExpiryConsole,
  classifyE2eKnownBrowserObservation,
  e2eBrowserExecutableCandidates,
  resolveE2eAdvanceSchedule,
  resolveE2eBuildMode,
  resolveE2eBuildTimeoutMs,
  resolveE2eBrowserEngine,
  resolveE2eCaptureArtifacts,
  resolveE2eTabKey,
  sanitizeE2eNetworkUrl,
} from "./e2e-browser-config.mjs";

describe("real E2E browser configuration", () => {
  it("defaults to Chromium and accepts the required three-engine matrix", () => {
    expect(resolveE2eBrowserEngine()).toBe("chromium");
    expect(E2E_BROWSER_ENGINES.map((engine) => resolveE2eBrowserEngine(engine)))
      .toEqual(["chromium", "firefox", "webkit"]);
  });

  it("rejects an unknown engine before starting disposable resources", () => {
    expect(() => resolveE2eBrowserEngine("chrome"))
      .toThrowError("E2E_BROWSER must be one of: chromium, firefox, webkit");
  });

  it("builds by default and accepts reuse only as an explicit matrix continuation", () => {
    expect(E2E_BUILD_MODES).toEqual(["build", "reuse"]);
    expect(resolveE2eBuildMode()).toBe("build");
    expect(resolveE2eBuildMode("reuse")).toBe("reuse");
    expect(() => resolveE2eBuildMode("skip")).toThrowError(
      "E2E_BUILD_MODE must be one of: build, reuse",
    );
  });

  it("keeps a ten-minute build timeout by default and bounds explicit overrides", () => {
    expect(resolveE2eBuildTimeoutMs()).toBe(600_000);
    expect(resolveE2eBuildTimeoutMs("7200000")).toBe(7_200_000);
    expect(() => resolveE2eBuildTimeoutMs("59999")).toThrowError(
      "E2E_BUILD_TIMEOUT_MS must be an integer between 60000 and 14400000",
    );
    expect(() => resolveE2eBuildTimeoutMs("14400001")).toThrowError(
      "E2E_BUILD_TIMEOUT_MS must be an integer between 60000 and 14400000",
    );
  });

  it("keeps real delayed publication by default and requires an explicit fixture clock advance", () => {
    expect(resolveE2eAdvanceSchedule()).toBe(false);
    expect(resolveE2eAdvanceSchedule("1")).toBe(true);
    expect(() => resolveE2eAdvanceSchedule("true")).toThrowError(
      "E2E_ADVANCE_SCHEDULE_AFTER_RESTART must be 0 or 1",
    );
  });

  it("captures heavy browser artifacts only by explicit opt-in", () => {
    expect(resolveE2eCaptureArtifacts()).toBe(false);
    expect(resolveE2eCaptureArtifacts("1")).toBe(true);
    expect(() => resolveE2eCaptureArtifacts("yes")).toThrowError(
      "E2E_CAPTURE_ARTIFACTS must be 0 or 1",
    );
  });

  it("keeps network evidence useful without persisting URL credentials or secrets", () => {
    const baseUrl = "https://127.0.0.1:43190";
    expect(sanitizeE2eNetworkUrl(
      "https://user:password@127.0.0.1:43190/bot/connect?token=raw&channel=7#secret",
      baseUrl,
    )).toBe("/bot/connect?token=%5BREDACTED%5D&channel=7");
    expect(sanitizeE2eNetworkUrl(
      "https://provider.test/callback?code=raw&state=visible",
      baseUrl,
    )).toBe("https://provider.test/callback?code=%5BREDACTED%5D&state=visible");
    expect(sanitizeE2eNetworkUrl("not a valid url", "not a base")).toBe("[invalid-url]");
  });

  it("uses native Option+Tab only for full keyboard traversal in macOS WebKit", () => {
    expect(resolveE2eTabKey({ engine: "webkit", platform: "darwin" })).toBe("Alt+Tab");
    expect(resolveE2eTabKey({ engine: "webkit", platform: "darwin", reverse: true })).toBe("Alt+Shift+Tab");
    expect(resolveE2eTabKey({ engine: "webkit", platform: "linux" })).toBe("Tab");
    expect(resolveE2eTabKey({ engine: "firefox", platform: "darwin", reverse: true })).toBe("Shift+Tab");
  });

  it("classifies only WebKit's exact screenshot CSP instrumentation while a screenshot is active", () => {
    const consoleMessage = "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.";
    const structuredMessage = `__AURORA_E2E_CSP_VIOLATION__${JSON.stringify({
      blockedURI: "inline",
      effectiveDirective: "style-src-elem",
      sourceFile: "",
      sample: "",
      disposition: "enforce",
    })}`;
    for (const message of [consoleMessage, structuredMessage]) {
      expect(classifyE2eKnownBrowserObservation({
        engine: "webkit",
        eventKind: "console",
        message,
        screenshotInProgress: true,
      })?.kind).toBe("playwright.webkit-screenshot-csp");
      expect(classifyE2eKnownBrowserObservation({
        engine: "webkit",
        eventKind: "console",
        message,
        screenshotInProgress: false,
      })).toBeNull();
      expect(classifyE2eKnownBrowserObservation({
        engine: "firefox",
        eventKind: "console",
        message,
        screenshotInProgress: true,
      })).toBeNull();
    }
    expect(classifyE2eKnownBrowserObservation({
      engine: "webkit",
      eventKind: "console",
      message: "Refused to apply an inline style from application code",
      screenshotInProgress: true,
    })).toBeNull();
  });

  it("keeps WebKit navigation-cancellation observations origin- and route-specific", () => {
    const classify = (message, currentUrl = "https://127.0.0.1:43190/app/calendar") =>
      classifyE2eKnownBrowserObservation({
        engine: "webkit",
        eventKind: "pageerror",
        message,
        currentUrl,
        webPort: 43190,
      });

    expect(classify("/127.0.0.1:43190/app/library?_rsc=abc_123 due to access control checks.")?.kind)
      .toBe("webkit.cancelled-rsc-prefetch");
    expect(classify(
      "/127.0.0.1:43190/api/media/generations due to access control checks.",
      "https://127.0.0.1:43190/app/studio?draft=3&intent=create",
    )?.kind).toBe("webkit.cancelled-studio-navigation-request");
    expect(classify("/127.0.0.1:43191/app/library?_rsc=abc due to access control checks."))
      .toBeNull();
    expect(classify("/127.0.0.1:43190/api/projects due to access control checks."))
      .toBeNull();
    expect(classify("/127.0.0.1:43190/app/library due to access control checks."))
      .toBeNull();
    expect(classifyE2eKnownBrowserObservation({
      engine: "chromium",
      eventKind: "pageerror",
      message: "/127.0.0.1:43190/app/library?_rsc=abc due to access control checks.",
      currentUrl: "https://127.0.0.1:43190/app/calendar",
      webPort: 43190,
    })).toBeNull();
  });

  it("classifies only exact first-party expiry 401 console output inside the expiry window", () => {
    const baseUrl = "https://127.0.0.1:43190";
    const resource401 = "Failed to load resource: the server responded with a status of 401 (Unauthorized)";
    expect(classifyE2eExpectedSessionExpiryConsole({
      active: true,
      message: resource401,
      sourceUrl: `${baseUrl}/api/projects/current`,
      baseUrl,
    })).toEqual({
      kind: "session-expiry.expected-api-401",
      detail: "/api/projects/current",
    });
    expect(classifyE2eExpectedSessionExpiryConsole({
      active: true,
      message: "[/app/calendar drafts] DraftRequestError: unauthorized\n at compiled code",
      sourceUrl: `${baseUrl}/_next/static/chunks/app/app/calendar/page.js`,
      baseUrl,
    })?.kind).toBe("session-expiry.expected-calendar-unauthorized");
    expect(classifyE2eExpectedSessionExpiryConsole({
      active: false,
      message: resource401,
      sourceUrl: `${baseUrl}/api/projects`,
      baseUrl,
    })).toBeNull();
    expect(classifyE2eExpectedSessionExpiryConsole({
      active: true,
      message: resource401,
      sourceUrl: "https://provider.test/api/projects",
      baseUrl,
    })).toBeNull();
    expect(classifyE2eExpectedSessionExpiryConsole({
      active: true,
      message: "TypeError: unexpected application failure",
      sourceUrl: `${baseUrl}/_next/static/chunks/app/app/calendar/page.js`,
      baseUrl,
    })).toBeNull();
  });

  it("uses system Chrome fallbacks only for Chromium", () => {
    expect(e2eBrowserExecutableCandidates({
      engine: "chromium",
      requested: "/custom/chrome",
      bundled: "/playwright/chromium",
      platform: "linux",
    })).toEqual([
      "/custom/chrome",
      "/playwright/chromium",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
    ]);
    expect(e2eBrowserExecutableCandidates({
      engine: "firefox",
      bundled: "/playwright/firefox",
      platform: "linux",
    })).toEqual(["/playwright/firefox"]);
    expect(e2eBrowserExecutableCandidates({
      engine: "webkit",
      bundled: "/playwright/webkit",
      platform: "darwin",
    })).toEqual(["/playwright/webkit"]);
  });
});
