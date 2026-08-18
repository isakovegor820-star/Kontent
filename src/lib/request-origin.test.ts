import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { hasTrustedMutationOrigin } from "./request-origin";

function request(headers: Record<string, string>) {
  return new NextRequest("http://internal:3000/api/drafts", {
    method: "POST",
    headers: { host: "internal:3000", ...headers },
  });
}

describe("hasTrustedMutationOrigin", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts a server-configured public origin without trusting forwarded headers", () => {
    vi.stubEnv("APP_URL", "https://aurora.example");
    expect(hasTrustedMutationOrigin(request({
      origin: "https://aurora.example",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "http",
      "sec-fetch-site": "same-origin",
    }))).toBe(true);
  });

  it("rejects cross-site and mismatched browser mutations", () => {
    expect(hasTrustedMutationOrigin(request({
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
    }))).toBe(false);
    expect(hasTrustedMutationOrigin(request({
      origin: "https://evil.example",
      "sec-fetch-site": "same-site",
    }))).toBe(false);
  });

  it("rejects requests without Origin and cannot be opened with forwarded metadata", () => {
    expect(hasTrustedMutationOrigin(request({}))).toBe(false);
    expect(hasTrustedMutationOrigin(request({
      origin: "https://evil.example",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "https",
    }))).toBe(false);
  });
});
