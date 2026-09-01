export const E2E_BOT_CONNECT_TOKEN_CANARY =
  "AURORA_E2E_BOT_CONNECT_TOKEN_CANARY_0000001";

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

export function isSensitiveE2eQueryParameter(name) {
  return SENSITIVE_QUERY_PARAMETER_PATTERN.test(String(name || ""));
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
  const findings = [];
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
