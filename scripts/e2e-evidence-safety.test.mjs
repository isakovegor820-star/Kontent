import { describe, expect, it } from "vitest";

import {
  E2E_BOT_CONNECT_TOKEN_CANARY,
  inspectE2eCanaryBuffer,
  inspectE2eNetworkEvents,
  inspectE2eTextEvidence,
  isSensitiveE2eQueryParameter,
} from "./e2e-evidence-safety.mjs";

describe("E2E evidence safety", () => {
  it("uses a valid-format synthetic one-time token canary", () => {
    expect(E2E_BOT_CONNECT_TOKEN_CANARY).toMatch(/^[A-Za-z0-9_-]{43}$/u);
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
