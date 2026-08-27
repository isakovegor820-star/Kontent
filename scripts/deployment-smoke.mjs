import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { SCHEMA_MANIFEST } from "../src/lib/schema-manifest.mjs";

const MAX_JSON_BYTES = 256 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_READINESS_AGE_MS = 5 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 10_000;
const HTML_PATHS = ["/", "/login"];
const FULL_CAPABILITIES = [
  "schemaReady",
  "webReady",
  "publicationReady",
  "aiReady",
  "mailDeliveryReady",
  "uploadReady",
  "tokenEncryptionReady",
  "trackingReady",
  "passwordRecoveryReady",
];
const RELEASE_CAPABILITIES = FULL_CAPABILITIES.filter(
  (capability) => capability !== "mailDeliveryReady" && capability !== "passwordRecoveryReady",
);
const WEB_CAPABILITIES = ["schemaReady", "webReady", "uploadReady"];
const TARGET_MIGRATIONS = new Set(SCHEMA_MANIFEST.migrations.map((migration) => migration.name));

export class DeploymentSmokeError extends Error {
  constructor(code, details = undefined) {
    super(code);
    this.name = "DeploymentSmokeError";
    this.code = code;
    this.details = details;
  }
}

function isPrivateIpv4(hostname) {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) return false;
  return octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || octets[0] === 0;
}

function isPrivateHost(hostname) {
  const normalized = hostname.toLowerCase()
    .replace(/\.$/u, "")
    .replace(/^\[|\]$/gu, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) {
    return true;
  }
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return isPrivateIpv4(normalized);
  if (ipVersion === 6) {
    return normalized === "::1"
      || normalized === "::"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || normalized.startsWith("fe80:");
  }
  return false;
}

function configuration(env) {
  const rawBaseUrl = String(env.AURORA_DEPLOYMENT_SMOKE_BASE_URL || "").trim();
  if (!rawBaseUrl) throw new DeploymentSmokeError("missing_deployment_smoke_base_url");
  let baseUrl;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    throw new DeploymentSmokeError("invalid_deployment_smoke_base_url");
  }
  if (baseUrl.protocol !== "https:") {
    throw new DeploymentSmokeError("deployment_smoke_requires_https");
  }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new DeploymentSmokeError("deployment_smoke_url_contains_credentials_or_metadata");
  }
  if (baseUrl.pathname !== "/" || isPrivateHost(baseUrl.hostname)) {
    throw new DeploymentSmokeError("deployment_smoke_target_not_public_origin");
  }
  const profile = String(env.AURORA_DEPLOYMENT_SMOKE_PROFILE || "full").trim();
  if (profile !== "web" && profile !== "release" && profile !== "full") {
    throw new DeploymentSmokeError("invalid_deployment_smoke_profile");
  }
  const readinessToken = String(env.AURORA_READINESS_TOKEN || "");
  if (readinessToken.length < 32) {
    throw new DeploymentSmokeError("missing_readiness_token");
  }
  const rawAllowForwardSchema = String(
    env.AURORA_DEPLOYMENT_SMOKE_ALLOW_FORWARD_SCHEMA || "false",
  ).trim();
  if (rawAllowForwardSchema !== "true" && rawAllowForwardSchema !== "false") {
    throw new DeploymentSmokeError("invalid_forward_schema_smoke_policy");
  }
  return {
    baseUrl,
    profile,
    readinessToken,
    allowForwardSchema: rawAllowForwardSchema === "true",
  };
}

async function boundedText(response, limit) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new DeploymentSmokeError("deployment_smoke_response_too_large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new DeploymentSmokeError("deployment_smoke_response_too_large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function request(fetchImpl, url, accept, maxBytes, extraHeaders = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        accept,
        "user-agent": "aurora-deployment-smoke/1",
        ...extraHeaders,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new DeploymentSmokeError("deployment_smoke_network_failure");
  }
  if (response.status >= 300 && response.status < 400) {
    throw new DeploymentSmokeError("deployment_smoke_unexpected_redirect");
  }
  const body = await boundedText(response, maxBytes).catch((error) => {
    if (error instanceof DeploymentSmokeError) throw error;
    throw new DeploymentSmokeError("deployment_smoke_response_invalid_utf8");
  });
  return { response, body };
}

function requireNoStore(response, surface) {
  const cacheControl = response.headers.get("cache-control") || "";
  if (!/(?:^|,)\s*(?:no-store|private)(?:\s|,|$)/iu.test(cacheControl)) {
    throw new DeploymentSmokeError("deployment_smoke_cache_policy_unsafe", { surface });
  }
}

function parseJsonResponse(result, surface, allowedStatuses = [200]) {
  if (!allowedStatuses.includes(result.response.status)) {
    let readiness;
    if (surface === "readiness") {
      try {
        const report = JSON.parse(result.body);
        const safeReason = (value) => {
          const reason = String(value || "");
          return /^[a-z0-9_.:-]{1,160}$/u.test(reason) ? reason : "invalid_readiness_reason";
        };
        readiness = {
          status: ["ready", "degraded", "not_ready"].includes(report?.status)
            ? report.status
            : "unknown",
          databaseReady: report?.databaseReady === true,
          schemaReady: report?.schemaReady === true,
          webReady: report?.webReady === true,
          uploadReady: report?.uploadReady === true,
          reasons: Array.isArray(report?.reasons)
            ? report.reasons.slice(0, 20).map(safeReason)
            : [],
          checks: {
            database: safeReason(report?.checks?.database),
            schemaReady: report?.checks?.schema?.ready === true,
            schemaReasons: Array.isArray(report?.checks?.schema?.reasons)
              ? report.checks.schema.reasons.slice(0, 20).map(safeReason)
              : [],
            uploadIngress: safeReason(report?.checks?.uploadIngress),
          },
        };
      } catch {
        // The status and surface remain actionable when the failure body is not JSON.
      }
    }
    throw new DeploymentSmokeError("deployment_smoke_http_failure", {
      surface,
      status: result.response.status,
      ...(readiness ? { readiness } : {}),
    });
  }
  if (!(result.response.headers.get("content-type") || "").toLowerCase().includes("application/json")) {
    throw new DeploymentSmokeError("deployment_smoke_content_type_mismatch", { surface });
  }
  requireNoStore(result.response, surface);
  try {
    return JSON.parse(result.body);
  } catch {
    throw new DeploymentSmokeError("deployment_smoke_invalid_json", { surface });
  }
}

function validateHealth(result) {
  const health = parseJsonResponse(result, "health");
  if (health?.ok !== true || health?.status !== "alive") {
    throw new DeploymentSmokeError("deployment_smoke_health_contract_failed");
  }
}

function requireFreshReadiness(readiness, now) {
  const checkedAt = Date.parse(String(readiness?.checkedAt || ""));
  if (!Number.isFinite(checkedAt) || Math.abs(now.getTime() - checkedAt) > MAX_READINESS_AGE_MS) {
    throw new DeploymentSmokeError("deployment_smoke_readiness_stale");
  }
}

function validateForwardCompatibleCurrentReadiness(readiness, profile, now) {
  requireFreshReadiness(readiness, now);
  const checks = readiness?.checks;
  const schemaReasons = Array.isArray(checks?.schema?.reasons) ? checks.schema.reasons : [];
  const knownForwardOnly = schemaReasons.length > 0 && schemaReasons.every((reason) => {
    const migration = String(reason).match(/^migration_unexpected:(.+\.sql)$/u)?.[1];
    return Boolean(migration && TARGET_MIGRATIONS.has(migration));
  });
  const aiProviders = Array.isArray(checks?.aiProviders) ? checks.aiProviders : [];
  const aiEvidenceSafe = aiProviders.length === 0
    || aiProviders.every((provider) => provider?.state !== "open" && provider?.lastOutcome === "success");
  const allowedReasons = new Set([
    ...schemaReasons.map(String),
    ...(checks?.publicationWorker === "down" ? ["publication_worker_unavailable"] : []),
    ...(checks?.telegramPolling === "down" ? ["telegram_polling_unavailable"] : []),
    ...(aiProviders.length === 0 ? ["ai_unobserved"] : []),
    ...(profile === "release"
      ? ["mail_delivery_not_configured", "mail_delivery_unavailable"]
      : []),
  ]);
  const reasons = Array.isArray(readiness?.reasons) ? readiness.reasons.map(String) : [];
  const checksByName = {
    target_known_forward_migrations: knownForwardOnly,
    process_alive: readiness?.processAlive === true,
    database: readiness?.databaseReady === true && checks?.database === "up",
    schema_blocked_only: checks?.schema?.ready === false,
    redis: checks?.redis === "up",
    publication_worker_recoverable: checks?.publicationWorker === "up"
      || checks?.publicationWorker === "down",
    telegram_polling_recoverable: checks?.telegramPolling === "up"
      || checks?.telegramPolling === "down",
    ai_configuration: checks?.aiConfigured === true && aiEvidenceSafe,
    upload_ingress: checks?.uploadIngress === "up",
    tracking_secrets: checks?.trackingSecrets === "up",
    mail_policy: profile === "release" || checks?.mailDelivery === "up",
    reasons_allowlisted: reasons.length >= schemaReasons.length
      && reasons.every((reason) => allowedReasons.has(reason)),
  };
  const failedChecks = Object.entries(checksByName)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  if (failedChecks.length > 0) {
    throw new DeploymentSmokeError("deployment_smoke_forward_schema_unverified", { failedChecks });
  }
  return "forward_compatible";
}

function validateReadiness(result, profile, now, allowForwardSchema = false) {
  if (allowForwardSchema && result.response.status === 503) {
    const readiness = parseJsonResponse(result, "readiness", [503]);
    return validateForwardCompatibleCurrentReadiness(readiness, profile, now);
  }
  const readiness = parseJsonResponse(result, "readiness");
  const required = profile === "full"
    ? FULL_CAPABILITIES
    : profile === "release"
      ? RELEASE_CAPABILITIES
      : WEB_CAPABILITIES;
  const failedCapabilities = required.filter((capability) => readiness?.[capability] !== true);
  if (failedCapabilities.length > 0) {
    throw new DeploymentSmokeError("deployment_smoke_readiness_failed", { failedCapabilities });
  }
  if (profile === "full" && readiness?.status !== "ready") {
    throw new DeploymentSmokeError("deployment_smoke_status_degraded");
  }
  requireFreshReadiness(readiness, now);
  return readiness.status;
}

function directive(csp, name) {
  return csp.split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `)) || "";
}

function elementNonces(html, tagName) {
  return Array.from(html.matchAll(new RegExp(`<${tagName}\\b([^>]*)>`, "giu")), (match) => {
    const attributes = match[1];
    const nonce = attributes.match(/\bnonce\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/iu);
    return nonce?.[1] || nonce?.[2] || nonce?.[3] || null;
  });
}

function validateHtml(result, path) {
  if (result.response.status !== 200) {
    throw new DeploymentSmokeError("deployment_smoke_http_failure", {
      surface: path,
      status: result.response.status,
    });
  }
  if (!(result.response.headers.get("content-type") || "").toLowerCase().includes("text/html")) {
    throw new DeploymentSmokeError("deployment_smoke_content_type_mismatch", { surface: path });
  }
  requireNoStore(result.response, path);
  const headers = result.response.headers;
  if (headers.has("x-powered-by")
    || headers.get("x-frame-options")?.toUpperCase() !== "DENY"
    || headers.get("x-content-type-options")?.toLowerCase() !== "nosniff"
    || headers.get("referrer-policy")?.toLowerCase() !== "strict-origin-when-cross-origin"
    || !headers.get("strict-transport-security")?.toLowerCase().includes("includesubdomains")) {
    throw new DeploymentSmokeError("deployment_smoke_security_headers_failed", { surface: path });
  }
  const csp = headers.get("content-security-policy") || "";
  const scriptDirective = directive(csp, "script-src");
  const styleDirective = directive(csp, "style-src");
  const nonceValues = Array.from(csp.matchAll(/'nonce-([^']+)'/gu), (match) => match[1]);
  const uniqueNonces = [...new Set(nonceValues)];
  if (uniqueNonces.length !== 1
    || !scriptDirective.includes("'strict-dynamic'")
    || scriptDirective.includes("'unsafe-inline'")
    || scriptDirective.includes("'unsafe-eval'")
    || !styleDirective.includes(`'nonce-${uniqueNonces[0]}'`)
    || directive(csp, "object-src") !== "object-src 'none'"
    || directive(csp, "frame-ancestors") !== "frame-ancestors 'none'") {
    throw new DeploymentSmokeError("deployment_smoke_csp_failed", { surface: path });
  }
  const scriptNonces = elementNonces(result.body, "script");
  const styleNonces = elementNonces(result.body, "style");
  if (scriptNonces.length === 0
    || [...scriptNonces, ...styleNonces].some((nonce) => nonce !== uniqueNonces[0])) {
    throw new DeploymentSmokeError("deployment_smoke_nonce_binding_failed", { surface: path });
  }
}

export async function runDeploymentSmoke({
  env = process.env,
  fetchImpl = fetch,
  logger = console,
  now = new Date(),
} = {}) {
  const { baseUrl, profile, readinessToken, allowForwardSchema } = configuration(env);
  const [health, readiness, ...htmlPages] = await Promise.all([
    request(fetchImpl, new URL("/api/health", baseUrl), "application/json", MAX_JSON_BYTES),
    request(
      fetchImpl,
      new URL("/api/readiness", baseUrl),
      "application/json",
      MAX_JSON_BYTES,
      { authorization: `Bearer ${readinessToken}` },
    ),
    ...HTML_PATHS.map((path) => request(fetchImpl, new URL(path, baseUrl), "text/html", MAX_HTML_BYTES)),
  ]);
  validateHealth(health);
  const status = validateReadiness(readiness, profile, now, allowForwardSchema);
  htmlPages.forEach((page, index) => validateHtml(page, HTML_PATHS[index]));
  const report = {
    ok: true,
    host: baseUrl.host,
    profile,
    readinessStatus: status,
    checkedPages: HTML_PATHS,
    checkedAt: now.toISOString(),
  };
  logger.log(JSON.stringify(report));
  return report;
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  runDeploymentSmoke().catch((error) => {
    const code = error instanceof DeploymentSmokeError ? error.code : "deployment_smoke_failed";
    const details = error instanceof DeploymentSmokeError ? error.details : undefined;
    console.error(JSON.stringify({ ok: false, code, ...(details ? { details } : {}) }));
    process.exitCode = 1;
  });
}
