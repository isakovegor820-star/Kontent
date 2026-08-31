import { isSensitiveE2eQueryParameter } from "./e2e-evidence-safety.mjs";

export const E2E_BROWSER_ENGINES = Object.freeze(["chromium", "firefox", "webkit"]);
export const E2E_BUILD_MODES = Object.freeze(["build", "reuse"]);

const PLAYWRIGHT_WEBKIT_SCREENSHOT_CSP_CONSOLE =
  "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.";
const AURORA_CSP_DIAGNOSTIC_PREFIX = "__AURORA_E2E_CSP_VIOLATION__";
const WEBKIT_CANCELLED_REQUEST_SUFFIX = " due to access control checks.";

export function resolveE2eBrowserEngine(value) {
  const engine = String(value || "chromium").trim().toLowerCase();
  if (!E2E_BROWSER_ENGINES.includes(engine)) {
    throw new Error(`E2E_BROWSER must be one of: ${E2E_BROWSER_ENGINES.join(", ")}`);
  }
  return engine;
}

export function resolveE2eBuildMode(value) {
  const mode = String(value || "build").trim().toLowerCase();
  if (!E2E_BUILD_MODES.includes(mode)) {
    throw new Error(`E2E_BUILD_MODE must be one of: ${E2E_BUILD_MODES.join(", ")}`);
  }
  return mode;
}

export function resolveE2eBuildTimeoutMs(value) {
  const raw = String(value || "").trim();
  if (!raw) return 10 * 60_000;
  const timeout = Number(raw);
  if (!Number.isSafeInteger(timeout) || timeout < 60_000 || timeout > 4 * 60 * 60_000) {
    throw new Error("E2E_BUILD_TIMEOUT_MS must be an integer between 60000 and 14400000");
  }
  return timeout;
}

export function resolveE2eAdvanceSchedule(value) {
  const raw = String(value || "0").trim();
  if (raw !== "0" && raw !== "1") {
    throw new Error("E2E_ADVANCE_SCHEDULE_AFTER_RESTART must be 0 or 1");
  }
  return raw === "1";
}

export function resolveE2eCaptureArtifacts(value) {
  const raw = String(value || "0").trim();
  if (raw !== "0" && raw !== "1") {
    throw new Error("E2E_CAPTURE_ARTIFACTS must be 0 or 1");
  }
  return raw === "1";
}

export function sanitizeE2eNetworkUrl(value, baseUrl) {
  try {
    const url = new URL(String(value), String(baseUrl));
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const name of [...url.searchParams.keys()]) {
      if (isSensitiveE2eQueryParameter(name)) {
        url.searchParams.set(name, "[REDACTED]");
      }
    }
    const baseOrigin = new URL(String(baseUrl)).origin;
    return url.origin === baseOrigin
      ? `${url.pathname}${url.search}`
      : `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return "[invalid-url]";
  }
}

export function resolveE2eTabKey({ engine, platform, reverse = false } = {}) {
  const browserEngine = resolveE2eBrowserEngine(engine);
  const useMacWebKitFullKeyboardChord = browserEngine === "webkit" && platform === "darwin";
  return [
    useMacWebKitFullKeyboardChord ? "Alt" : null,
    reverse ? "Shift" : null,
    "Tab",
  ].filter(Boolean).join("+");
}

function screenshotCspDetail(message) {
  if (message === PLAYWRIGHT_WEBKIT_SCREENSHOT_CSP_CONSOLE) return "console";
  if (!message.startsWith(AURORA_CSP_DIAGNOSTIC_PREFIX)) return null;
  try {
    const detail = JSON.parse(message.slice(AURORA_CSP_DIAGNOSTIC_PREFIX.length));
    if (
      detail?.blockedURI === "inline"
      && detail?.effectiveDirective === "style-src-elem"
      && detail?.sourceFile === ""
      && detail?.sample === ""
      && detail?.disposition === "enforce"
    ) return "securitypolicyviolation";
  } catch {}
  return null;
}

export function classifyE2eKnownBrowserObservation({
  engine,
  eventKind,
  message,
  currentUrl,
  webPort,
  screenshotInProgress = false,
} = {}) {
  if (resolveE2eBrowserEngine(engine) !== "webkit") return null;
  const rawMessage = String(message || "");

  if (eventKind === "console" && screenshotInProgress) {
    const detail = screenshotCspDetail(rawMessage);
    if (detail) return { kind: "playwright.webkit-screenshot-csp", detail };
  }

  if (eventKind !== "pageerror" || !rawMessage.endsWith(WEBKIT_CANCELLED_REQUEST_SUFFIX)) {
    return null;
  }
  const port = Number(webPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
  const requestTarget = rawMessage.slice(0, -WEBKIT_CANCELLED_REQUEST_SUFFIX.length);
  const originPrefix = `/127.0.0.1:${port}`;
  if (!requestTarget.startsWith(`${originPrefix}/`)) return null;
  const pathAndQuery = requestTarget.slice(originPrefix.length);

  try {
    const rscUrl = new URL(pathAndQuery, "https://aurora-e2e.invalid");
    const rscToken = rscUrl.searchParams.get("_rsc");
    if (
      /^\/app(?:\/[a-z0-9-]+)+$/u.test(rscUrl.pathname)
      && /^[A-Za-z0-9_-]+$/u.test(rscToken || "")
    ) {
      return { kind: "webkit.cancelled-rsc-prefetch", detail: pathAndQuery };
    }
  } catch {}

  let sourcePath = "";
  try {
    sourcePath = new URL(String(currentUrl || "")).pathname;
  } catch {}
  const studioTransitionRequest = pathAndQuery === "/api/rss/items?summary=unread"
    || pathAndQuery === "/api/media/generations"
    || pathAndQuery === "/api/media/capabilities"
    || /^\/api\/drafts\/\d+$/u.test(pathAndQuery);
  if (sourcePath === "/app/studio" && studioTransitionRequest) {
    return { kind: "webkit.cancelled-studio-navigation-request", detail: pathAndQuery };
  }
  return null;
}

export function classifyE2eKnownWebKitRequestCancellation({
  engine,
  requestUrl,
  failure,
  currentUrl,
  baseUrl,
  webPort,
} = {}) {
  if (resolveE2eBrowserEngine(engine) !== "webkit" || String(failure || "") !== "cancelled") {
    return null;
  }
  let request;
  let expectedBase;
  try {
    request = new URL(String(requestUrl || ""));
    expectedBase = new URL(String(baseUrl || ""));
  } catch {
    return null;
  }
  if (request.origin !== expectedBase.origin) return null;
  const rawMessage = `/${request.hostname}:${request.port}${request.pathname}${request.search}${WEBKIT_CANCELLED_REQUEST_SUFFIX}`;
  const observation = classifyE2eKnownBrowserObservation({
    engine,
    eventKind: "pageerror",
    message: rawMessage,
    currentUrl,
    webPort,
  });
  return observation ? { ...observation, message: rawMessage } : null;
}

export function classifyE2eKnownWebKitDocumentNavigationCancellation({
  engine,
  requestUrl,
  requestMethod,
  resourceType,
  failure,
  documentRequestUrl,
  elapsedMs,
  baseUrl,
  webPort,
} = {}) {
  if (
    resolveE2eBrowserEngine(engine) !== "webkit"
    || String(requestMethod || "").toUpperCase() !== "GET"
    || String(resourceType || "") !== "fetch"
    || String(failure || "") !== "cancelled"
  ) {
    return null;
  }
  const elapsed = Number(elapsedMs);
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 250) return null;
  let request;
  let documentRequest;
  let expectedBase;
  try {
    request = new URL(String(requestUrl || ""));
    documentRequest = new URL(String(documentRequestUrl || ""));
    expectedBase = new URL(String(baseUrl || ""));
  } catch {
    return null;
  }
  const port = Number(webPort);
  if (
    request.origin !== expectedBase.origin
    || documentRequest.origin !== expectedBase.origin
    || request.hostname !== "127.0.0.1"
    || Number(request.port) !== port
    || !/^\/api(?:\/|$)/u.test(request.pathname)
    || !/^\/app(?:\/|$)/u.test(documentRequest.pathname)
  ) return null;
  return {
    kind: "webkit.cancelled-api-document-navigation",
    detail: `${request.pathname}${request.search}`,
    message: `/${request.hostname}:${request.port}${request.pathname}${request.search}${WEBKIT_CANCELLED_REQUEST_SUFFIX}`,
  };
}

export function classifyE2eExpectedSessionExpiryWebKitPageError({
  active = false,
  engine,
  eventKind,
  message,
  currentUrl,
  baseUrl,
  webPort,
} = {}) {
  if (
    !active
    || resolveE2eBrowserEngine(engine) !== "webkit"
    || eventKind !== "pageerror"
  ) return null;
  const rawMessage = String(message || "");
  if (!rawMessage.endsWith(WEBKIT_CANCELLED_REQUEST_SUFFIX)) return null;
  const port = Number(webPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
  let current;
  let base;
  try {
    current = new URL(String(currentUrl || ""));
    base = new URL(String(baseUrl || ""));
  } catch {
    return null;
  }
  if (
    current.origin !== base.origin
    || base.hostname !== "127.0.0.1"
    || Number(base.port) !== port
  ) return null;
  const requestTarget = rawMessage.slice(0, -WEBKIT_CANCELLED_REQUEST_SUFFIX.length);
  const originPrefix = `/127.0.0.1:${port}`;
  if (!requestTarget.startsWith(`${originPrefix}/`)) return null;
  const pathAndQuery = requestTarget.slice(originPrefix.length);
  const expectedPaths = {
    "/app/calendar": ["/api/drafts", "/api/projects", "/api/projects/current"],
    "/app/studio": [
      "/api/studio/session",
      "/api/settings",
      "/api/ai/engines",
      "/api/channels",
      "/api/posts",
    ],
  }[current.pathname];
  if (!expectedPaths?.includes(pathAndQuery)) {
    return null;
  }
  return { kind: "session-expiry.webkit-cancelled-api-request", detail: pathAndQuery };
}

export function classifyE2eExpectedSessionExpiryConsole({
  active = false,
  message,
  sourceUrl,
  baseUrl,
} = {}) {
  if (!active) return null;
  const rawMessage = String(message || "");
  let source;
  let base;
  try {
    source = new URL(String(sourceUrl || ""));
    base = new URL(String(baseUrl || ""));
  } catch {
    return null;
  }
  if (source.origin !== base.origin) return null;

  if (
    rawMessage === "Failed to load resource: the server responded with a status of 401 (Unauthorized)"
    && source.pathname.startsWith("/api/")
  ) {
    return { kind: "session-expiry.expected-api-401", detail: source.pathname };
  }
  const calendarPrefix = "[/app/calendar drafts] ";
  if (rawMessage.startsWith(calendarPrefix) && source.pathname.includes("/app/app/calendar/")) {
    try {
      const detail = JSON.parse(rawMessage.slice(calendarPrefix.length));
      if (
        detail?.name === "DraftRequestError"
        && detail?.kind === "failed"
        && detail?.status === 401
        && detail?.code === "unauthorized"
      ) {
        return { kind: "session-expiry.expected-calendar-unauthorized", detail: "/api/drafts" };
      }
    } catch {}
  }
  return null;
}

export function e2eBrowserExecutableCandidates(input) {
  const engine = resolveE2eBrowserEngine(input?.engine);
  const requested = String(input?.requested || "").trim();
  const bundled = String(input?.bundled || "").trim();
  const platform = String(input?.platform || "").trim();
  const candidates = [requested, bundled];
  if (engine === "chromium") {
    if (platform === "darwin") {
      candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    }
    if (platform === "linux") candidates.push("/usr/bin/google-chrome", "/usr/bin/chromium");
  }
  return Object.freeze([...new Set(candidates.filter(Boolean))]);
}
