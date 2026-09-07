export const E2E_BOT_CONNECT_TOKEN_CANARIES = Object.freeze({
  unknown: "AURORA_E2E_BOT_CONNECT_TOKEN_CANARY_0000001",
  expired: "AURORA_E2E_BOT_CONNECT_TOKEN_CANARY_0000002",
  lifecycle: "AURORA_E2E_BOT_CONNECT_TOKEN_CANARY_0000003",
  malformed: "AURORA_E2E_MALFORMED_TOKEN",
});

export const E2E_BOT_CONNECT_TOKEN_CANARY = E2E_BOT_CONNECT_TOKEN_CANARIES.unknown;

const SENSITIVE_QUERY_PARAMETER_PATTERN =
  /^(?:access[_-]?token|api[_-]?key|auth(?:orization)?|client[_-]?secret|code|cookie|credential|jwt|password|passwd|refresh[_-]?token|session(?:id)?|sid|signature|token)$/iu;

const UNREDACTED_TEXT_PATTERNS = Object.freeze([
  {
    kind: "authorization-bearer",
    pattern: /authorization\s*[:=]\s*bearer\s+(?!\[redacted\])[^\s,}\]]+/giu,
  },
  {
    kind: "json-sensitive-field",
    pattern: /"(?:access[_-]?token|api[_-]?key|auth(?:orization)?|client[_-]?secret|cookie|credential|jwt|password|passwd|refresh[_-]?token|session(?:id)?|sid|signature|token)"\s*:\s*"(?!\[redacted\])[^"\r\n]+"/giu,
  },
  {
    kind: "url-sensitive-query",
    pattern: /[?&](?:access[_-]?token|api[_-]?key|auth(?:orization)?|client[_-]?secret|code|cookie|credential|jwt|password|passwd|refresh[_-]?token|session(?:id)?|sid|signature|token)=(?!%5Bredacted%5D|\[redacted\])[^&#\s"']+/giu,
  },
]);

const EMAIL_PATTERN = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/giu;
const INTERNATIONAL_PHONE_PATTERN = /(?<![\p{L}\p{N}])\+(?:\d[\s().-]*){7,14}\d(?!\d)/gu;
const FILE_LIKE_EMAIL_SUFFIXES = new Set([
  "avif", "csv", "gif", "html", "jpeg", "jpg", "json", "log", "md", "mjs", "mov",
  "mp4", "pdf", "png", "svg", "ts", "tsx", "txt", "webm", "xlsx", "xml", "zip",
]);
const RESERVED_SYNTHETIC_EMAIL_DOMAINS = new Set(["example.com", "example.net", "example.org"]);
const RESERVED_SYNTHETIC_EMAIL_ADDRESSES = new Set(["name@example.ru"]);
const RESERVED_SYNTHETIC_EMAIL_SUFFIXES = Object.freeze([".example", ".invalid", ".localhost", ".test"]);

export const E2E_PII_SCAN_POLICY = Object.freeze({
  version: 1,
  textDetectors: Object.freeze(["email", "international-phone"]),
  syntheticEmailDomains: Object.freeze([
    ...RESERVED_SYNTHETIC_EMAIL_DOMAINS,
    ...RESERVED_SYNTHETIC_EMAIL_SUFFIXES.map((suffix) => `*${suffix}`),
  ]),
  syntheticEmailAddresses: Object.freeze([...RESERVED_SYNTHETIC_EMAIL_ADDRESSES]),
  archiveTextPayloads: true,
  imageOcr: false,
});

function normalizePiiEncoding(text) {
  return text
    .replace(/%40/giu, "@")
    .replace(/%2b/giu, "+")
    .replace(/%20/giu, " ")
    .replace(/%28/giu, "(")
    .replace(/%29/giu, ")")
    .replace(/%2d/giu, "-")
    .replace(/&#0*64;|&commat;/giu, "@");
}

function isSyntheticEmail(candidate) {
  if (RESERVED_SYNTHETIC_EMAIL_ADDRESSES.has(candidate.toLowerCase())) return true;
  const separator = candidate.lastIndexOf("@");
  if (separator < 0) return false;
  const domain = candidate.slice(separator + 1).toLowerCase();
  if (RESERVED_SYNTHETIC_EMAIL_DOMAINS.has(domain)) return true;
  return RESERVED_SYNTHETIC_EMAIL_SUFFIXES.some(
    (suffix) => domain === suffix.slice(1) || domain.endsWith(suffix),
  );
}

function isFileLikeEmail(candidate) {
  const domain = candidate.slice(candidate.lastIndexOf("@") + 1).toLowerCase();
  const suffix = domain.slice(domain.lastIndexOf(".") + 1);
  return FILE_LIKE_EMAIL_SUFFIXES.has(suffix);
}

function inspectPiiText(path, content) {
  const text = normalizePiiEncoding(content);
  const findings = [];
  EMAIL_PATTERN.lastIndex = 0;
  let match;
  while ((match = EMAIL_PATTERN.exec(text)) !== null) {
    if (!isSyntheticEmail(match[0]) && !isFileLikeEmail(match[0])) {
      findings.push({ kind: "email-pii", path, offset: match.index });
    }
  }
  INTERNATIONAL_PHONE_PATTERN.lastIndex = 0;
  while ((match = INTERNATIONAL_PHONE_PATTERN.exec(text)) !== null) {
    findings.push({ kind: "international-phone-pii", path, offset: match.index });
  }
  return findings;
}

export function isSensitiveE2eQueryParameter(name) {
  return SENSITIVE_QUERY_PARAMETER_PATTERN.test(String(name || ""));
}

export function escapeE2eUnzipEntryPattern(path) {
  return String(path || "").replace(/[?*[\[]/gu, (character) => {
    if (character === "[") return "[[]";
    return `[${character}]`;
  });
}

export function inspectE2eNetworkEvents(events, baseUrl = "https://aurora-e2e.invalid") {
  const findings = [];
  for (const [index, event] of Array.from(events || []).entries()) {
    let url;
    try {
      url = new URL(String(event?.url || ""), baseUrl);
    } catch {
      findings.push({ kind: "invalid-network-url", index });
      continue;
    }
    if (url.username || url.password) {
      findings.push({ kind: "url-credentials", index });
    }
    if (url.hash) findings.push({ kind: "url-fragment", index });
    for (const [name, value] of url.searchParams) {
      if (isSensitiveE2eQueryParameter(name) && value !== "[REDACTED]") {
        findings.push({ kind: "sensitive-query", index, parameter: name });
      }
    }
  }
  return findings;
}

export function inspectE2eTextEvidence(path, content) {
  const text = String(content || "");
  const findings = inspectPiiText(path, text);
  for (const { kind, pattern } of UNREDACTED_TEXT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      findings.push({ kind, path, offset: match.index });
    }
  }
  return findings;
}

export function inspectE2eCanaryBuffer(path, content, canaries) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const findings = [];
  for (const canary of Array.from(canaries || [])) {
    const label = String(canary?.label || "").trim();
    const value = String(canary?.value || "");
    if (!label || value.length < 16) {
      throw new Error("E2E evidence canaries require a label and at least 16 characters");
    }
    if (buffer.includes(Buffer.from(value, "utf8"))) {
      findings.push({ kind: "sensitive-canary", path, label });
    }
  }
  return findings;
}
