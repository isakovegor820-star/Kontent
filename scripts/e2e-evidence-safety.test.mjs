import { describe, expect, it } from "vitest";

import {
  E2E_BOT_CONNECT_TOKEN_CANARY,
  E2E_BOT_CONNECT_TOKEN_CANARIES,
  E2E_PII_SCAN_POLICY,
  escapeE2eUnzipEntryPattern,
  inspectE2eCanaryBuffer,
  inspectE2eNetworkEvents,
  inspectE2eTextEvidence,
  isSensitiveE2eQueryParameter,
} from "./e2e-evidence-safety.mjs";

describe("E2E evidence safety", () => {
  it("escapes unzip wildcard characters without changing ordinary entry paths", () => {
    expect(escapeE2eUnzipEntryPattern("[Content_Types].xml")).toBe("[[]Content_Types].xml");
    expect(escapeE2eUnzipEntryPattern("trace/resources/file?.json")).toBe(
      "trace/resources/file[?].json",
    );
    expect(escapeE2eUnzipEntryPattern("trace/resources/*.json")).toBe(
      "trace/resources/[*].json",
    );
    expect(escapeE2eUnzipEntryPattern("xl/worksheets/sheet1.xml")).toBe(
      "xl/worksheets/sheet1.xml",
    );
  });

  it("uses a valid-format synthetic one-time token canary", () => {
    expect(E2E_BOT_CONNECT_TOKEN_CANARY).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(E2E_BOT_CONNECT_TOKEN_CANARIES.malformed).not.toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(Object.values(E2E_BOT_CONNECT_TOKEN_CANARIES)).toHaveLength(4);
    expect(new Set(Object.values(E2E_BOT_CONNECT_TOKEN_CANARIES)).size).toBe(4);
    for (const [state, value] of Object.entries(E2E_BOT_CONNECT_TOKEN_CANARIES)) {
      if (state !== "malformed") expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(value.length).toBeGreaterThanOrEqual(16);
    }
  });

  it.each([
    "access_token",
    "api-key",
    "authorization",
    "client_secret",
    "code",
    "cookie",
    "credential",
    "jwt",
    "password",
    "passwd",
    "refresh-token",
    "session",
    "sessionId",
    "sid",
    "signature",
    "token",
  ])("classifies %s as a sensitive query parameter", (name) => {
    expect(isSensitiveE2eQueryParameter(name)).toBe(true);
  });

  it("does not classify operational query parameters as secrets", () => {
    for (const name of ["channel", "draft", "idempotency-key", "source", "state", "_rsc"]) {
      expect(isSensitiveE2eQueryParameter(name)).toBe(false);
    }
  });

  it("rejects credentials, fragments, invalid URLs, and unredacted sensitive queries", () => {
    expect(inspectE2eNetworkEvents([
      { url: "/app/studio?draft=7" },
      { url: "/bot/connect?token=%5BREDACTED%5D&source=telegram" },
      { url: "https://user:pass@example.test/path" },
      { url: "/path#token=raw" },
      { url: "/callback?sid=raw" },
      { url: "http://[invalid" },
    ])).toEqual([
      { kind: "url-credentials", index: 2 },
      { kind: "url-fragment", index: 3 },
      { kind: "sensitive-query", index: 4, parameter: "sid" },
      { kind: "invalid-network-url", index: 5 },
    ]);
  });

  it("reports evidence categories without echoing secret values", () => {
    const findings = inspectE2eTextEvidence("runner.log", [
      "authorization: Bearer raw-value",
      '"password":"raw-password"',
      "https://example.test/callback?session=raw-session",
    ].join("\n"));
    expect(findings.map(({ kind }) => kind)).toEqual([
      "authorization-bearer",
      "json-sensitive-field",
      "url-sensitive-query",
    ]);
    expect(JSON.stringify(findings)).not.toContain("raw-value");
    expect(JSON.stringify(findings)).not.toContain("raw-password");
    expect(JSON.stringify(findings)).not.toContain("raw-session");
    expect(inspectE2eTextEvidence(
      "network-log.json",
      'authorization: Bearer [redacted]\n{"token":"[redacted]"}\n/callback?token=%5BREDACTED%5D',
    )).toEqual([]);
  });

  it("detects live-like email and international phone PII without echoing values", () => {
    const findings = inspectE2eTextEvidence(
      "network-log.json",
      "mailto:real.person@private-mail.ru tel:+7 (927) 123-45-67 encoded=other%40private-mail.ru",
    );
    expect(findings.map(({ kind }) => kind)).toEqual([
      "email-pii",
      "email-pii",
      "international-phone-pii",
    ]);
    expect(JSON.stringify(findings)).not.toContain("real.person");
    expect(JSON.stringify(findings)).not.toContain("927");
  });

  it("allows documented synthetic addresses and ignores artifact filenames", () => {
    expect(inspectE2eTextEvidence("result.json", [
      "qa-e2e@aurora.test",
      "person@example.com",
      "nobody@fixture.invalid",
      "name@example.ru",
      "page@0540b2d131f43b117dc1f845dbc0b07c.webm",
    ].join("\n"))).toEqual([]);
    expect(E2E_PII_SCAN_POLICY).toMatchObject({
      version: 1,
      textDetectors: ["email", "international-phone"],
      archiveTextPayloads: true,
      imageOcr: false,
    });
    expect(E2E_PII_SCAN_POLICY.syntheticEmailAddresses).toEqual(["name@example.ru"]);
  });

  it("finds exact canaries in binary evidence without returning their values", () => {
    const findings = inspectE2eCanaryBuffer(
      "main-trace.zip",
      Buffer.from(`prefix:${E2E_BOT_CONNECT_TOKEN_CANARY}:suffix`),
      [{ label: "bot-connect-token", value: E2E_BOT_CONNECT_TOKEN_CANARY }],
    );
    expect(findings).toEqual([
      { kind: "sensitive-canary", path: "main-trace.zip", label: "bot-connect-token" },
    ]);
    expect(JSON.stringify(findings)).not.toContain(E2E_BOT_CONNECT_TOKEN_CANARY);
  });

  it("rejects unsafe canary definitions", () => {
    expect(() => inspectE2eCanaryBuffer("result.json", "text", [{ label: "short", value: "tiny" }]))
      .toThrowError("E2E evidence canaries require a label and at least 16 characters");
  });
});
