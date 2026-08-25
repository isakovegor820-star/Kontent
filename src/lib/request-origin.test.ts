import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { hasTrustedMutationOrigin } from "./request-origin";

function request(headers: Record<string, string>, url = "http://internal:3000/api/drafts") {
  return new NextRequest(url, {
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
    expect(hasTrustedMutationOrigin(request({ cookie: "sid=ambient" }))).toBe(false);
    expect(hasTrustedMutationOrigin(request({
      origin: "https://evil.example",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "https",
    }))).toBe(false);
  });

  it("accepts same-origin Fetch Metadata when Origin is omitted", () => {
    expect(hasTrustedMutationOrigin(request({
      cookie: "sid=ambient",
      "sec-fetch-site": "same-origin",
    }))).toBe(true);
  });

  it("accepts the actual same-origin dev port when APP_URL uses another local port", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_URL", "http://localhost:3001");
    expect(hasTrustedMutationOrigin(request({
      host: "localhost:3000",
      origin: "http://localhost:3000",
      cookie: "sid=ambient",
      "sec-fetch-site": "same-origin",
    }))).toBe(true);
  });

  it("accepts a real 127.0.0.1 Host even when Next normalized req.url to localhost", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_URL", "http://localhost:3000");
    expect(hasTrustedMutationOrigin(request({
      host: "127.0.0.1:3001",
      origin: "http://127.0.0.1:3001",
      cookie: "sid=ambient",
      "sec-fetch-site": "same-origin",
    }, "http://localhost:3001/api/auth/login"))).toBe(true);
  });

  it("rejects loopback suffixes and mismatched local Host values", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(hasTrustedMutationOrigin(request({
      host: "127.0.0.1:3001",
      origin: "http://127.0.0.1.evil.example:3001",
      "sec-fetch-site": "same-origin",
    }))).toBe(false);
    expect(hasTrustedMutationOrigin(request({
      host: "localhost:3001",
      origin: "http://127.0.0.1:3001",
      "sec-fetch-site": "same-origin",
    }))).toBe(false);
  });

  it("leaves cookie-less service calls to route authentication but keeps browser-only flows strict", () => {
    expect(hasTrustedMutationOrigin(request({ authorization: "Bearer service-token" }))).toBe(true);
    expect(hasTrustedMutationOrigin(
      request({ authorization: "Bearer service-token" }),
      { requireBrowserOrigin: true },
    )).toBe(false);
  });

  it("uses APP_URL as the only production origin trust anchor", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_URL", "https://aurora.example");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://public.example");
    vi.stubEnv("AURORA_ALLOWED_ORIGINS", "https://extra.example");
    expect(hasTrustedMutationOrigin(request({ origin: "https://aurora.example" }))).toBe(true);
    expect(hasTrustedMutationOrigin(request({ origin: "https://public.example" }))).toBe(false);
    expect(hasTrustedMutationOrigin(request({ origin: "https://extra.example" }))).toBe(false);
  });

  it("fails closed in production when APP_URL is absent or non-HTTPS", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_URL", "");
    expect(hasTrustedMutationOrigin(request({ origin: "https://aurora.example" }))).toBe(false);
    vi.stubEnv("APP_URL", "http://aurora.example");
    expect(hasTrustedMutationOrigin(request({ origin: "http://aurora.example" }))).toBe(false);
  });
});
